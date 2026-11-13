import {
  createTranslator,
  type Locale,
} from "../../../packages/i18n/src/index.ts";
import en from "../../../packages/i18n/locales/en.reputation.json" with { type: "json" };
import uk from "../../../packages/i18n/locales/uk.reputation.json" with { type: "json" };
const translate = createTranslator({ en, uk });
export const reputationText = (
  locale: Locale,
  key: string,
  values?: Record<string, string | number>,
) => translate(locale, key as Parameters<typeof translate>[1], values);
import type {
  ModuleApi,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
export type ReputationOptions = {
  api: ModuleApi;
  navigation: Navigation;
  locale(): Locale;
  authenticated: boolean;
  actorKey?(): string | null;
};

export const titleKeys = {
  tasks: "tasks",
  reputation: "title",
  "reputation-item": "item.title",
};
