import { en, uk } from "./dictionaries.ts";

export type Locale = "en" | "uk";
export { displayAmount, parseUnits } from "./amount.ts";
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

function resolve(
  messages: object,
  locale: Locale,
  key: string,
  values: Values,
): string {
  const path = key.split(".");
  let message: unknown = messages;
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
  return resolve(dictionaries[locale], locale, key, values);
}

/** Module-owned messages can travel with a lazy screen instead of the shell. */
export function createTranslator<T extends object>(
  messages: Record<Locale, T>,
) {
  return (locale: Locale, key: MessagePath<T>, values: Values = {}) =>
    resolve(messages[locale], locale, key, values);
}
