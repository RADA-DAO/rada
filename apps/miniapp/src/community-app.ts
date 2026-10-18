import { reportCopy } from "./report-copy.ts";
import * as payment from "./payment-copy.ts";
import { consentCopy } from "./permissions.ts";
import type { Locale } from "../../../packages/i18n/src/index.ts";
import type {
  initializePlatform,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  mountAppHost,
  type AppRelease,
} from "../../../packages/platform-sdk/src/app-host.ts";

export function mountCommunityApp(options: {
  platform: ReturnType<typeof initializePlatform>;
  navigation: Navigation;
  release: AppRelease;
  container: HTMLElement;
  artifactOrigin: string;
  locale: Locale;
  signal: AbortSignal;
  back(): void;
}) {
  const { platform, navigation, release, container, artifactOrigin, locale } =
    options;
  return mountAppHost({
    signal: options.signal,
    navigation,
    release,
    container,
    artifactOrigin,
    locale,
    appCapability: (appId, hash, operation, payload, signal) =>
      platform.appCapability(appId, hash, operation, payload, signal),
    reportCopy: reportCopy(locale),
    consentCopy: (permission, appName) =>
      consentCopy(locale, permission, appName),
    readConsent: (appId, permission) =>
      platform.readAppConsent(appId, permission),
    writeConsent: (appId, permission, granted) =>
      platform.writeAppConsent(appId, permission, granted),
    ownSubject: async () =>
      (await platform.readOwnProfile())?.subject_id ?? null,
    readWalletAddress: (appId, signal) =>
      platform.readAppWalletAddress(appId, signal),
    readWalletBalances: (appId, signal) =>
      platform.readAppWalletBalances(appId, signal),
    ...payment.paymentHostAdapter(platform, locale, payment.setPaymentBusy),
    onNavigateBack: () => {
      options.back();
    },
  });
}
