// @flow
import type { Account } from "../types";
import { log } from "@ledgerhq/logs";
import type { Result } from "../cross";
import { accountDataToAccount } from "../cross";
import { findAccountMigration, checkAccountSupported } from "./support";
import joinSwapHistories from "../swap/joinSwapHistories";
import isEqual from "lodash/isEqual";

const itemModeDisplaySort = {
  create: 1,
  update: 2,
  id: 3,
  unsupported: 4,
};

export type ImportItemMode = $Keys<typeof itemModeDisplaySort>;
export type ImportItem = {
  initialAccountId: string,
  account: Account,
  mode: ImportItemMode,
};

export const importAccountsMakeItems = ({
  result,
  accounts,
  items,
}: {
  result: Result,
  accounts: Account[],
  items?: ImportItem[],
}): ImportItem[] =>
  result.accounts
    .map((accInput) => {
      const prevItem = (items || []).find(
        (item) => item.account.id === accInput.id
      );
      if (prevItem) return prevItem;

      try {
        const account = accountDataToAccount(accInput);
        const error = checkAccountSupported(account);
        if (error) {
          return {
            initialAccountId: account.id,
            account,
            mode: "unsupported",
          };
        }
        const migratableAccount = accounts.find((a) =>
          findAccountMigration(a, [account])
        );
        if (migratableAccount) {
          // in migration case, we completely replace the older account
          return {
            initialAccountId: migratableAccount.id,
            account,
            mode: "update",
          };
        }
        const existingAccount = accounts.find((a) => a.id === accInput.id);
        if (existingAccount) {
          // only the name is supposed to change. rest is never changing
          if (
            existingAccount.name === accInput.name &&
            isEqual(existingAccount.swapHistory, account.swapHistory) // FIXME sorting? i'm lazy
          ) {
            return {
              initialAccountId: existingAccount.id,
              account: existingAccount,
              mode: "id",
            };
          }
          return {
            initialAccountId: existingAccount.id,
            account: {
              ...existingAccount,
              name: accInput.name,
              swapHistory: joinSwapHistories(
                existingAccount.swapHistory,
                account.swapHistory
              ),
            },
            mode: "update",
          };
        }

        return {
          initialAccountId: account.id,
          account,
          mode: "create",
        };
      } catch (e) {
        log("error", String(e));
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => itemModeDisplaySort[a.mode] - itemModeDisplaySort[b.mode]);

export const importAccountsReduce = (
  existingAccounts: Account[],
  {
    items,
    selectedAccounts,
  }: {
    items: ImportItem[],
    selectedAccounts: string[],
  }
): Account[] => {
  const accounts = existingAccounts.slice(0);
  const selectedItems = items.filter((item) =>
    selectedAccounts.includes(item.account.id)
  );
  for (const { mode, account, initialAccountId } of selectedItems) {
    switch (mode) {
      case "create":
        accounts.push(account);
        break;
      case "update": {
        const item = accounts.find((a) => a.id === initialAccountId);
        const i = accounts.indexOf(item);
        accounts[i] = account;
        break;
      }
      default:
    }
  }
  return accounts;
};
