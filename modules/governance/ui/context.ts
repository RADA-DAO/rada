import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import type { Navigation } from "../../../packages/platform-sdk/src/index.ts";
import type { Client } from "./client.ts";
import { GovernanceError } from "./client.ts";
export const translator =
  (locale: Locale) => (key: string, values?: Record<string, string | number>) =>
    t(locale, `governance.${key}` as MessageKey, values);
export type Context = {
  text: ReturnType<typeof translator>;
  locale: Locale;
  client: Client;
  navigation: Navigation;
  signal: AbortSignal;
  member: boolean;
  steward: boolean;
  refresh(): Promise<void>;
};
export function errorText(ctx: Context, error: unknown): string {
  const code = error instanceof GovernanceError ? error.status : 0;
  return ctx.text(
    `error.${String([400, 401, 403, 404, 409, 429, 503].includes(code) ? code : 0)}`,
    {
      seconds: error instanceof GovernanceError ? (error.retryAfter ?? 60) : 60,
    },
  );
}
