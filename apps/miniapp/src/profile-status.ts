import {
  applyTheme,
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
} from "../../../packages/ui/src/index.ts";
import { openSettings } from "./settings.ts";
import { ErrorState, Text } from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
export function profileStatus(
  locale: Locale,
  state: string,
  retry: () => void,
): Node[] {
  if (state === "guest") return [Text(t(locale, "shell.guestDescription"))];
  if (state !== "expired" && state !== "unavailable") return [];
  return [
    ErrorState({
      message: t(
        locale,
        state === "expired"
          ? "shell.expiredDescription"
          : "shell.unavailableDescription",
      ),
      retryLabel: t(locale, "common.retry"),
      onRetry: retry,
    }),
  ];
}

export function showShellSettings(
  locale: Locale,
  navigation: Parameters<typeof openSettings>[0]["navigation"],
  opener: HTMLElement | null,
  change: (value: Locale) => void,
  notifications?: Parameters<typeof openSettings>[0]["notifications"],
) {
  openSettings({
    locale,
    navigation,
    opener,
    change,
    ...(notifications ? { notifications } : {}),
  });
}

export function applyProfileTheme(
  frog: { background_color: string | null; accent_color: string | null } | null,
) {
  applyTheme(
    document.documentElement,
    compileTheme(
      frog?.background_color ?? DEFAULT_THEME_BACKGROUND,
      frog?.accent_color,
    ),
  );
}
