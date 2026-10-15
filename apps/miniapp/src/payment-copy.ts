import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type { PaymentCopy } from "../../../packages/platform-sdk/src/index.ts";
import { initializePlatform } from "../../../packages/platform-sdk/src/index.ts";
export let paymentBusy = false;
let activeRequests = 0;
export const setPaymentBusy = (value: boolean) => {
  activeRequests = Math.max(0, activeRequests + (value ? 1 : -1));
  paymentBusy = activeRequests > 0;
};

export function paymentCopy(locale: Locale): PaymentCopy {
  return {
    locale,
    title: t(locale, "payment.title"),
    token: t(locale, "payment.token"),
    amount: t(locale, "payment.amount"),
    recipient: t(locale, "payment.recipient"),
    purpose: t(locale, "payment.purpose"),
    fee: t(locale, "payment.fee"),
    feeWallet: t(locale, "payment.feeWallet"),
    gasBudget: t(locale, "payment.gasBudget"),
    confirm: t(locale, "payment.confirm"),
    cancel: t(locale, "payment.cancel"),
    unknown: t(locale, "payment.unknown"),
  };
}
export function paymentHostAdapter(
  platform: ReturnType<typeof initializePlatform>,
  locale: Locale,
  active: (value: boolean) => void,
) {
  return {
    async requestPayment(appId: string, payload: unknown, signal: AbortSignal) {
      active(true);
      try {
        return await platform.requestPayment(
          appId,
          payload,
          paymentCopy(locale),
          signal,
        );
      } finally {
        active(false);
      }
    },
    paymentStatus: (appId: string, intentId: string) =>
      platform.paymentStatus(appId, intentId),
  };
}
