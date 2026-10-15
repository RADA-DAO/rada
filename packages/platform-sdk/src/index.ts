import { installAppKeyboard } from "./keyboard.ts";
export {
  configurePageBack,
  pageBackNavigation,
  setPageBackActive,
  deferPageBackRender,
} from "./page-back.ts";
export { installSwipeBack } from "./swipe-back.ts";

type Insets = { top?: number; right?: number; bottom?: number; left?: number };
type TelegramHost = {
  initData?: string;
  viewportHeight?: number;
  safeAreaInset?: Insets;
  contentSafeAreaInset?: Insets;
  ready(): void;
  expand(): void;
  onEvent(name: string, handler: () => void): void;
  offEvent(name: string, handler: () => void): void;
  setBottomBarColor?(color: string): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  BackButton: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
};
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramHost };
  }
}

/** Platform-owned adapter. Raw launch credentials remain enclosed in the own API read. */
export function initializePlatform(options: {
  doneLabel: () => string;
  dismissLabel: () => string;
  onBack: () => void;
  themeColor: string;
  apiOrigin?: string;
}) {
  const host = window.Telegram?.WebApp;
  const apiOrigin = options.apiOrigin ? new URL(options.apiOrigin) : undefined;
  if (
    apiOrigin &&
    (apiOrigin.origin !== options.apiOrigin ||
      (apiOrigin.protocol !== "https:" &&
        !(
          apiOrigin.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(apiOrigin.hostname)
        )))
  )
    throw new Error("Invalid API origin");
  const profileUrl = apiOrigin ? `${apiOrigin.origin}/me` : "/api/me";
  const sync = () => {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const inset =
        Math.max(0, host?.safeAreaInset?.[side] ?? 0) +
        Math.max(0, host?.contentSafeAreaInset?.[side] ?? 0);
      document.documentElement.style.setProperty(
        `--app-safe-${side}`,
        `${inset}px`,
      );
    }
    document.documentElement.style.setProperty(
      "--app-workspace-safe-top",
      document.documentElement.style.getPropertyValue("--app-safe-top"),
    );
    keyboard.refresh();
  };
  const keyboard = installAppKeyboard({
    doneLabel: options.doneLabel,
    dismissLabel: options.dismissLabel,
    hostHeight: () => host?.viewportHeight,
  });
  const events = [
    "viewportChanged",
    "safeAreaChanged",
    "contentSafeAreaChanged",
    "themeChanged",
  ];
  host?.ready();
  host?.expand();
  host?.setHeaderColor?.(options.themeColor);
  host?.setBackgroundColor?.(options.themeColor);
  host?.setBottomBarColor?.(options.themeColor);
  document.documentElement.style.setProperty(
    "--telegram-keyboard-edge",
    options.themeColor,
  );
  host?.BackButton.onClick(options.onBack);
  for (const event of events) host?.onEvent(event, sync);
  sync();
  return {
    authenticatedLaunch: Boolean(host?.initData),
    setBackVisible(visible: boolean) {
      if (visible) host?.BackButton.show();
      else host?.BackButton.hide();
    },
    async readOwnProfile() {
      if (!host?.initData) return null;
      const response = await fetch(profileUrl, {
        headers: { Authorization: `tma ${host.initData}` },
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "expired" : "unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("profile" in value) ||
        !("subject_id" in value) ||
        typeof value.subject_id !== "string" ||
        !value.profile ||
        typeof value.profile !== "object" ||
        !("visibility" in value.profile) ||
        value.profile.visibility !== "private" ||
        !("public" in value.profile) ||
        value.profile.public !== null
      )
        throw new Error("unavailable");
      return value;
    },
    dispose() {
      keyboard.dispose();
      host?.BackButton.offClick(options.onBack);
      host?.BackButton.hide();
      for (const event of events) host?.offEvent(event, sync);
    },
  };
}
