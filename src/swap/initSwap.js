// @flow

import secp256k1 from "secp256k1";
import invariant from "invariant";
import { getAbandonSeedAddress } from "../data/abandonseed";
import Swap from "./hw-app-swap/Swap";
import { mockInitSwap } from "./mock";
import perFamily from "../generated/swap";
import { getAccountCurrency, getMainAccount, getAccountUnit } from "../account";
import network from "../network";
import { getAccountBridge } from "../bridge";
import { BigNumber } from "bignumber.js";
import { SwapGenericAPIError } from "../errors";
import type {
  Exchange,
  ExchangeRate,
  InitSwap,
  SwapRequestEvent,
} from "./types";
import type { Transaction } from "../types";
import { Observable } from "rxjs";
import { withDevice } from "../hw/deviceAccess";
import {
  getCurrencySwapConfig,
  getProviderNameAndSignature,
  swapAPIBaseURL,
} from "./";
import { getEnv } from "../env";

const initSwap: InitSwap = (
  exchange: Exchange,
  exchangeRate: ExchangeRate,
  transaction: Transaction,
  deviceId: string
): Observable<SwapRequestEvent> => {
  if (getEnv("MOCK")) return mockInitSwap(exchange, exchangeRate, deviceId);
  return withDevice("")((transport) =>
    Observable.create((o) => {
      let unsubscribed = false;
      const confirmSwap = async () => {
        const swap = new Swap(transport);
        // NB this id is crucial to prevent replay attacks, if it changes
        // we need to start the flow again.
        const deviceTransactionId = await swap.startNewTransaction();
        const { provider, rateId } = exchangeRate;
        const {
          fromParentAccount,
          fromAccount,
          toParentAccount,
          toAccount,
        } = exchange;
        const { amount } = transaction;
        const refundCurrency = getAccountCurrency(fromAccount);
        const unitFrom = getAccountUnit(exchange.fromAccount);
        const payoutCurrency = getAccountCurrency(toAccount);
        const refundAccount = getMainAccount(fromAccount, fromParentAccount);
        const payoutAccount = getMainAccount(toAccount, toParentAccount);
        const apiAmount = amount.div(BigNumber(10).pow(unitFrom.magnitude));

        // Request a lock on the specified rate for 20 minutes,
        // user is expected to send funds after this.
        // NB Added the try/catch because of the API stability issues.
        let res;
        try {
          res = await network({
            method: "POST",
            url: `${swapAPIBaseURL}/swap`,
            data: [
              {
                provider,
                amountFrom: apiAmount,
                from: refundCurrency.id,
                to: payoutCurrency.id,
                rateId,
                address: payoutAccount.freshAddress,
                refundAddress: refundAccount.freshAddress,
                deviceTransactionId,
              },
            ],
          });
        } catch (e) {
          o.next({
            type: "init-swap-error",
            error: new SwapGenericAPIError(),
          });
          o.complete();
          unsubscribed = true;
        }

        if (unsubscribed || !res || !res.data) return;

        const swapResult = res.data[0];
        const { swapId, provider: providerName } = swapResult;
        const providerNameAndSignature = getProviderNameAndSignature(
          providerName
        );

        // FIXME because this would break for tokens
        if (payoutCurrency.type !== "CryptoCurrency") {
          throw new Error("How do I handle non CryptoCurrencies");
        }
        if (refundCurrency.type !== "CryptoCurrency") {
          throw new Error("How do I handle non CryptoCurrencies");
        }

        const accountBridge = getAccountBridge(refundAccount);
        transaction = accountBridge.updateTransaction(transaction, {
          recipient: swapResult.payinAddress,
        });

        // Triplecheck we're not working with an abandonseed recipient anymore
        invariant(
          transaction.recipient !== getAbandonSeedAddress(refundCurrency.id),
          "Recipient address should never be the abandonseed address"
        );

        transaction = await accountBridge.prepareTransaction(
          refundAccount,
          transaction
        );

        const {
          errors,
          estimatedFees,
        } = await accountBridge.getTransactionStatus(
          refundAccount,
          transaction
        );

        if (errors.recipient || errors.amount) {
          throw errors.recipient || errors.amount;
        }

        // Prepare swap app to receive the tx to forward.
        await swap.setPartnerKey(providerNameAndSignature.nameAndPubkey);
        await swap.checkPartner(providerNameAndSignature.signature);
        await swap.processTransaction(
          Buffer.from(swapResult.binaryPayload, "hex"),
          estimatedFees
        );
        const goodSign = secp256k1.signatureExport(
          Buffer.from(swapResult.signature, "hex")
        );
        await swap.checkTransactionSignature(goodSign);
        const payoutAddressParameters = await perFamily[
          payoutCurrency.family
        ].getSerializedAddressParameters(
          payoutAccount.freshAddressPath,
          payoutAccount.derivationMode
        );

        const {
          config: payoutAddressConfig,
          signature: payoutAddressConfigSignature,
        } = getCurrencySwapConfig(payoutCurrency);

        await swap.checkPayoutAddress(
          payoutAddressConfig,
          payoutAddressConfigSignature,
          payoutAddressParameters.addressParameters
        );

        const refundAddressParameters = await perFamily[
          refundCurrency.family
        ].getSerializedAddressParameters(
          refundAccount.freshAddressPath,
          refundAccount.derivationMode
        );

        const {
          config: refundAddressConfig,
          signature: refundAddressConfigSignature,
        } = getCurrencySwapConfig(refundCurrency);

        if (unsubscribed) return;
        o.next({ type: "init-swap-requested" });
        await swap.checkRefundAddress(
          refundAddressConfig,
          refundAddressConfigSignature,
          refundAddressParameters.addressParameters
        );
        await swap.signCoinTransaction();

        if (unsubscribed) return;
        o.next({
          type: "init-swap-result",
          initSwapResult: { transaction, swapId },
        });
      };
      confirmSwap().then(
        () => {
          o.complete();
          unsubscribed = true;
        },
        (e) => {
          o.next({
            type: "init-swap-error",
            error: e,
          });
          o.complete();
          unsubscribed = true;
        }
      );
      return () => {
        unsubscribed = true;
      };
    })
  );
};

export default initSwap;