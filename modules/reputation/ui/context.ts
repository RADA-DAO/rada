import type { Locale } from "../../../packages/i18n/src/index.ts";
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
