import {
  parseReviewQueue,
  appSlug,
  versionUuid,
  type ReviewVersion,
} from "./review-registry.ts";
export type { ReviewVersion } from "./review-registry.ts";
import { installAppKeyboard } from "./keyboard.ts";
import { CONSENT_PERMISSIONS } from "./app-manifest.ts";
export type MembershipStatus = "member" | "not_member" | "unavailable";
export type OwnProfile = {
  subject_id: string;
  profile:
    | { visibility: "private"; public: null }
    | {
        visibility: "public";
        public: {
          frog_id: string;
          username: string;
          background_color: string | null;
          accent_color: string | null;
        };
      };
  membership: { status: MembershipStatus };
};
export type AppConsent = { app_id: string; capability: string };
function validPublicFrog(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frog = value as Record<string, unknown>;
  const color = (value: unknown) =>
    value === null ||
    (typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value));
  return (
    Object.keys(frog).length === 4 &&
    typeof frog.frog_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      frog.frog_id,
    ) &&
    typeof frog.username === "string" &&
    /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(frog.username) &&
    color(frog.background_color) &&
    color(frog.accent_color)
  );
}
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
    async readReviewQueue(signal?: AbortSignal): Promise<ReviewVersion[]> {
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(
        `${apiOrigin?.origin ?? "/api"}/apps/review-queue`,
        { headers, credentials: "omit", cache: "no-store", signal },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "expired"
            : response.status === 403
              ? "forbidden"
              : "unavailable",
        );
      const value: unknown = await response.json();
      return parseReviewQueue(value);
    },
    async reviewAppVersion(
      appId: string,
      versionId: string,
      decision: "approve" | "reject",
      reason: string,
      signal?: AbortSignal,
    ): Promise<void> {
      if (
        !appSlug.test(appId) ||
        !versionUuid.test(versionId) ||
        !["approve", "reject"].includes(decision) ||
        !reason.trim() ||
        reason.length > 500
      )
        throw new Error("invalid_request");
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(
        `${apiOrigin?.origin ?? "/api"}/apps/${encodeURIComponent(appId)}/versions/${versionId}/${decision}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() }),
          credentials: "omit",
          cache: "no-store",
          signal,
        },
      );
      if (!response.ok)
        throw new Error(
          response.status === 401
            ? "expired"
            : response.status === 403
              ? "forbidden"
              : [404, 409].includes(response.status)
                ? "stale"
                : "unavailable",
        );
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("appId" in value) ||
        value.appId !== appId ||
        !("versionId" in value) ||
        value.versionId !== versionId ||
        !("status" in value) ||
        value.status !== (decision === "approve" ? "approved" : "rejected")
      )
        throw new Error("unavailable");
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
        Array.isArray(value) ||
        Object.keys(value).length !== 3 ||
        !("profile" in value) ||
        !("subject_id" in value) ||
        typeof value.subject_id !== "string" ||
        !value.profile ||
        typeof value.profile !== "object" ||
        Array.isArray(value.profile) ||
        Object.keys(value.profile).length !== 2 ||
        !("visibility" in value.profile) ||
        !("public" in value.profile) ||
        (value.profile.visibility === "private"
          ? value.profile.public !== null
          : value.profile.visibility === "public"
            ? !validPublicFrog(value.profile.public)
            : true) ||
        !("membership" in value) ||
        !value.membership ||
        typeof value.membership !== "object" ||
        Array.isArray(value.membership) ||
        Object.keys(value.membership).length !== 1 ||
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
