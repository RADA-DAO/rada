import type { Locale } from "./index.ts";

type Amount = { raw: string; decimals: number } | null;

/** Formats an exact integer amount of smallest units for the locale. */
export function displayAmount(
  amount: Amount,
  locale: Locale,
  minimumFractionDigits: number,
  maximumFractionDigits = minimumFractionDigits,
): string | null {
  if (!amount) return null;
  const divisor = 10n ** BigInt(amount.decimals);
  const scale = 10n ** BigInt(maximumFractionDigits);
  const rounded = (BigInt(amount.raw) * scale + divisor / 2n) / divisor;
  const whole = rounded / scale;
  const fraction = (rounded % scale)
    .toString()
    .padStart(maximumFractionDigits, "0")
    .replace(/0+$/, "")
    .padEnd(minimumFractionDigits, "0");
  const formatter = new Intl.NumberFormat(locale);
  const separator =
    formatter.formatToParts(1.1).find((part) => part.type === "decimal")
      ?.value ?? ".";
  return formatter.format(whole) + (fraction ? separator + fraction : "");
}

/**
 * Parses a typed decimal amount (either `.` or `,` as separator, spaces
 * ignored) into smallest units as a decimal string. Returns null for anything
 * that is not a positive amount with at most `decimals` fraction digits.
 */
export function parseUnits(input: string, decimals: number): string | null {
  const text = input.replace(/[\s\u00a0\u202f]/g, "").replace(",", ".");
  const match = /^(\d{1,30})(?:\.(\d+))?$/.exec(text);
  if (!match) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const units = BigInt((match[1] ?? "0") + fraction.padEnd(decimals, "0"));
  return units > 0n ? units.toString() : null;
}
