import {
  Button,
  List,
  ListItem,
  Text,
  openSheet,
  type SheetNavigation,
} from "../../ui/src/index.ts";

export type PaymentCopy = {
  locale: "en" | "uk";
  title: string;
  token: string;
  amount: string;
  recipient: string;
  purpose: string;
  fee: string;
  gasBudget: string;
  feeWallet: string;
  confirm: string;
  cancel: string;
  unknown: string;
};
export type Payment = {
  intentId: string;
  status: "prepared" | "unknown" | "paid" | "cancelled";
  token: string;
  amount: string;
  recipient: string;
  sender: string;
  purpose: string;
  network: "-239";
  gasBudget: string | null;
  feeEstimate: { nano: string; expiresAt: number } | null;
};
function units(raw: string, locale: "en" | "uk"): string {
  if (!/^(0|[1-9][0-9]{0,76})$/.test(raw)) throw new Error("unavailable");
  const padded = raw.padStart(10, "0");
  const fractional = padded.slice(-9).replace(/0+$/, "");
  const whole = new Intl.NumberFormat(locale).format(
    BigInt(padded.slice(0, -9)),
  );
  return `${whole}${fractional ? (locale === "uk" ? "," : ".") + fractional : ""}`;
}
/** Confirm a payment in a platform sheet; Back, Escape and swipe cancel. */
export function windowConfirm(
  payment: Payment,
  copy: PaymentCopy,
  signal: AbortSignal,
  navigation?: SheetNavigation,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let accepted = false;
    const lines: [string, string][] = [
      [copy.token, payment.token],
      [copy.amount, `${units(payment.amount, copy.locale)} ${payment.token}`],
      [copy.recipient, payment.recipient],
      [copy.purpose, payment.purpose],
      [copy.fee, `${units(payment.feeEstimate?.nano ?? "0", copy.locale)} TON`],
    ];
    if (payment.gasBudget)
      lines.push([
        copy.gasBudget,
        `${units(payment.gasBudget, copy.locale)} TON`,
      ]);
    const fields = List({
      children: lines.map(([label, value]) =>
        ListItem({
          title: label,
          children: [Text(value, { breakAnywhere: true })],
        }),
      ),
    });
    const allow = Button(copy.confirm, {
      onClick: () => {
        accepted = true;
        dialog.close();
      },
    });
    const abort = () => {
      dialog.close();
    };
    const dialog = openSheet({
      title: copy.title,
      closeLabel: copy.cancel,
      children: [fields, Text(copy.feeWallet), allow],
      ...(navigation ? { navigation } : {}),
      onClose: () => {
        signal.removeEventListener("abort", abort);
        resolve(accepted && !signal.aborted);
      },
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
