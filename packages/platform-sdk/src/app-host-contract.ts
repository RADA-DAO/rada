import type { AppManifest, AppPermission } from "./app-manifest.ts";
import type { ReportCopy } from "./app-report.ts";
import type { SheetNavigation } from "../../ui/src/index.ts";
export type AppRelease = {
  appId: string;
  versionId?: string;
  manifest: AppManifest;
  artifactUrl: string;
  artifactSha256: string;
  // Derived by the trusted release registry, never by rada.app.json or a child message.
  grantedPermissions: readonly AppPermission[];
};
export type ConsentCopy = {
  title: string;
  description: string;
  allow: string;
  deny: string;
};
export type AppHostOptions = {
  signal?: AbortSignal;
  release: AppRelease;
  container: HTMLElement;
  artifactOrigin: string;
  locale: "en" | "uk";
  consentCopy(permission: string, appName: string): ConsentCopy;
  readConsent(appId: string, permission: string): Promise<boolean>;
  writeConsent(
    appId: string,
    permission: string,
    granted: boolean,
  ): Promise<boolean>;
  reportCopy?: ReportCopy;
  appCapability?(
    appId: string,
    hash: string,
    operation: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  ownSubject(): Promise<string | null>;
  readWalletAddress?(appId: string, signal: AbortSignal): Promise<unknown>;
  readWalletBalances?(appId: string, signal: AbortSignal): Promise<unknown>;
  requestPayment?(
    appId: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  paymentStatus?(appId: string, intentId: string): Promise<unknown>;
  onNavigateBack?(): void;
  /** Platform stack, so permission prompts close with Back, Escape and swipe. */
  navigation?: SheetNavigation;
  onError?(code: string): void;
};
