import en from "../../../packages/i18n/locales/en.notifications.json" with { type: "json" };
import uk from "../../../packages/i18n/locales/uk.notifications.json" with { type: "json" };
export const kinds = [
  "won",
  "deadline",
  "claimed",
  "burned",
  "opened",
  "closing",
  "decision",
  "test",
] as const;
export type Kind = (typeof kinds)[number];
/** Fixed templates accept no private or user-authored data. */
export function message(locale: "en" | "uk", kind: Kind): string {
  return (locale === "uk" ? uk : en)[kind === "test" ? "testMessage" : kind];
}
