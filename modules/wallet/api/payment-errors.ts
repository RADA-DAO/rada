// Stable names, so platform modules can recognise these without importing classes.
export class PaymentConflict extends Error {
  override name = "PaymentConflict";
}
export class PaymentDenied extends Error {
  override name = "PaymentDenied";
}
/** The intent's signing window (a platform deadline) has closed. */
export class PaymentExpired extends Error {
  override name = "PaymentExpired";
}
