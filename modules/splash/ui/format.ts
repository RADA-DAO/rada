import {
  displayAmount,
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";

/** JPEGPE has 9 decimals; amounts travel as smallest units. */
export const JPEGPE_DECIMALS = 9;
/** JPEGPE's username rule, mirrored only to skip a request for an obvious typo. */
export const NAME_RULE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

export type Text = (key: MessageKey, values?: Record<string, string>) => string;
export const translator =
  (locale: Locale): Text =>
  (key, values) =>
    t(locale, key, values);

/** "12.5 JPEGPE" with the locale's separator and no trailing zeros. */
export function jpegpe(locale: Locale, units: string): string {
  const value = displayAmount(
    { raw: units, decimals: JPEGPE_DECIMALS },
    locale,
    0,
    JPEGPE_DECIMALS,
  );
  return t(locale, "splash.amount", { amount: value ?? "0" });
}

/** Remaining time as hours:minutes:seconds; hours may exceed 24. */
export function clock(remaining: number): string {
  const seconds = Math.max(0, Math.ceil(remaining / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

/** A UTC day (a round), such as "16 Oct 2026". */
export function utcDay(locale: Locale, at: number): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(at);
}

/** A moment in UTC, such as a claim deadline. */
export function utcMoment(locale: Locale, at: number): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(at);
}

/** Waiting time from `Retry-After`, rounded up to minutes. */
export function waitMinutes(seconds: number | null): string {
  return String(Math.max(1, Math.ceil((seconds ?? 60) / 60)));
}
