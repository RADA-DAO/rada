import en from "../locales/en.json" with { type: "json" };
import uk from "../locales/uk.json" with { type: "json" };

export type Locale = "en" | "uk";
type PluralForms = { other: string } & Partial<
  Record<Intl.LDMLPluralRule, string>
>;
type MessagePath<T, Prefix extends string = ""> = {
  [Key in keyof T & string]: T[Key] extends string
    ? `${Prefix}${Key}`
    : T[Key] extends PluralForms
      ? `${Prefix}${Key}`
      : T[Key] extends object
        ? MessagePath<T[Key], `${Prefix}${Key}.`>
        : never;
}[keyof T & string];
export type MessageKey = MessagePath<typeof en>;
type Values = Record<string, string | number>;
type Messages = typeof en;
const dictionaries: Record<Locale, Messages> = { en, uk };

function resolve(locale: Locale, key: MessageKey, values: Values): string {
  const path = key.split(".");
  let message: unknown = dictionaries[locale];
  for (const part of path) message = (message as Record<string, unknown>)[part];
  if (message && typeof message === "object" && "other" in message) {
    const count = Number(values.count ?? 0);
    const category = new Intl.PluralRules(locale).select(count);
    const forms = message as Record<string, string>;
    message = forms[category] ?? forms.other ?? message;
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
