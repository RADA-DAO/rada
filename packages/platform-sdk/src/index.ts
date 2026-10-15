import { installAppKeyboard } from "./keyboard.ts";
import { CONSENT_PERMISSIONS } from "./app-manifest.ts";
export type MembershipStatus = "member" | "not_member" | "unavailable";
export type OwnProfile = {
  subject_id: string;
  profile: { visibility: "private"; public: null };
  membership: { status: MembershipStatus };
};
export type AppConsent = { app_id: string; capability: string };
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
  const consentsUrl = `${profileUrl}/consents`;
  const authHeaders = () =>
    host?.initData ? { Authorization: `tma ${host.initData}` } : null;
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
      const headers = authHeaders();
      if (!headers) return null;
      const response = await fetch(profileUrl, {
        headers,
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
        value.profile.public !== null ||
        !("membership" in value) ||
        !value.membership ||
        typeof value.membership !== "object" ||
        !("status" in value.membership) ||
        typeof value.membership.status !== "string" ||
        !["member", "not_member", "unavailable"].includes(
          value.membership.status,
        )
      )
        throw new Error("unavailable");
      return value as OwnProfile;
    },
    async readAppConsents(): Promise<AppConsent[]> {
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(consentsUrl, {
        headers,
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "expired" : "unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("consents" in value) ||
        !Array.isArray(value.consents)
      )
        throw new Error("unavailable");
      if (
        value.consents.some(
          (item: unknown) =>
            !item ||
            typeof item !== "object" ||
            Array.isArray(item) ||
            !("app_id" in item) ||
            typeof item.app_id !== "string" ||
            !("capability" in item) ||
            typeof item.capability !== "string" ||
            !CONSENT_PERMISSIONS.includes(
              item.capability as (typeof CONSENT_PERMISSIONS)[number],
            ),
        )
      )
        throw new Error("unavailable");
      return value.consents as AppConsent[];
    },
    async readAppConsent(appId: string, capability: string): Promise<boolean> {
      return (await this.readAppConsents()).some(
        (item) => item.app_id === appId && item.capability === capability,
      );
    },
    async writeAppConsent(
      appId: string,
      capability: string,
      granted: boolean,
    ): Promise<boolean> {
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(consentsUrl, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ appId, capability, granted }),
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "expired" : "unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("granted" in value) ||
        typeof value.granted !== "boolean"
      )
        throw new Error("unavailable");
      return value.granted;
    },
    dispose() {
      keyboard.dispose();
      host?.BackButton.offClick(options.onBack);
      host?.BackButton.hide();
      for (const event of events) host?.offEvent(event, sync);
    },
  };
}
