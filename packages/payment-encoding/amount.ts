/** Maximum integer supported by the payment coin encoding. */
export const MAX_PAYMENT_AMOUNT = (1n << 120n) - 1n;
export function validPaymentAmount(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,36}$/.test(value) &&
    BigInt(value) <= MAX_PAYMENT_AMOUNT
  );
}
