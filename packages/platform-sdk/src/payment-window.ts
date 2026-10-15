import { Button, Sheet } from "../../ui/src/index.ts";

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
export function windowConfirm(
  payment: Payment,
  copy: PaymentCopy,
  signal: AbortSignal,
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
    const estimateNote = document.createElement("p");
    estimateNote.textContent = copy.feeWallet;
    if (payment.gasBudget)
      lines.push([
        copy.gasBudget,
        `${units(payment.gasBudget, copy.locale)} TON`,
      ]);
    const fields = lines.map(([label, value]) => {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;
      p.append(strong, document.createTextNode(value));
      p.style.overflowWrap = "anywhere";
      return p;
    });
    const allow = Button(copy.confirm, {
      onClick: () => {
        accepted = true;
        dialog.close();
      },
    });
    const dialog = Sheet({
      title: copy.title,
      closeLabel: copy.cancel,
      children: [...fields, estimateNote, allow],
    });
    dialog.addEventListener(
      "close",
      () => {
        signal.removeEventListener("abort", abort);
        dialog.remove();
        resolve(accepted && !signal.aborted);
      },
      { once: true },
    );
    document.body.append(dialog);
    const abort = () => {
      dialog.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    dialog.showModal();
  });
}
