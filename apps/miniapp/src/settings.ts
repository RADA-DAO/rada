import { notificationSettings } from "./notifications.ts";
import type { ModuleApi } from "../../../packages/platform-sdk/src/module-api.ts";
import {
  Field,
  openSheet,
  type SheetNavigation,
} from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";

export function openSettings(options: {
  locale: Locale;
  notifications?: ModuleApi;
  change: (locale: Locale) => void;
  navigation: SheetNavigation;
  opener: HTMLElement | null;
}): HTMLDialogElement {
  const { locale } = options;
  const language = Field({
    label: t(locale, "shell.language"),
    kind: "select",
    value: locale,
    choices: [
      { value: "en", label: t(locale, "shell.english") },
      { value: "uk", label: t(locale, "shell.ukrainian") },
    ],
    onChange: (value) => {
      dialog.close();
      options.change(value as Locale);
    },
  });
  const dialog = openSheet({
    title: t(locale, "shell.settings"),
    closeLabel: t(locale, "common.close"),
    children: [
      language.element,
      ...(options.notifications
        ? [notificationSettings(options.notifications, locale)]
        : []),
    ],
    navigation: options.navigation,
    opener: options.opener,
  });
  return dialog;
}
