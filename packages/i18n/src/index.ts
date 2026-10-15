import en from "../locales/en.json" with { type: "json" };
import uk from "../locales/uk.json" with { type: "json" };

export type Locale = "en" | "uk";
export type MessageKey =
  | "common.loading"
  | "common.retry"
  | "common.close"
  | "common.dismiss"
  | "state.empty"
  | "state.error"
  | "state.items";
type Values = Record<string, string | number>;
type Messages = typeof en;
const dictionaries: Record<Locale, Messages> = { en, uk };

function resolve(locale: Locale, key: MessageKey, values: Values): string {
  const path = key.split(".");
  let message: unknown = dictionaries[locale];
  for (const part of path) message = (message as Record<string, unknown>)[part];
  if (key === "state.items") {
    const count = Number(values.count ?? 0);
    const category = new Intl.PluralRules(locale).select(count);
    const forms = message as Record<string, string>;
    message = forms[category] ?? forms.other;
  }
  return String(message).replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
    String(values[name] ?? ""),
  );
}

export function t(
  locale: Locale,
  key: MessageKey,
  values: Values = {},
): string {
  return resolve(locale, key, values);
}
