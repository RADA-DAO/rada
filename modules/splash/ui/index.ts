import type { Locale, MessageKey } from "../../../packages/i18n/src/index.ts";
import type {
  ModuleApi,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import { splashClient } from "./api.ts";
import { SPLASH_ROUTES, type PayResult, type SplashRoute } from "./context.ts";
import { translator } from "./format.ts";
import { mountMine } from "./mine.ts";
import { mountPond } from "./pond.ts";
import { mountResults } from "./results.ts";
import { mountSubmit } from "./submit.ts";

export { SPLASH_ROUTES, type SplashRoute } from "./context.ts";

/** The SPLASH app id, as the wallet and the launcher know it. */
export const SPLASH_APP_ID = "splash";

const titles: Record<SplashRoute, MessageKey> = {
  splash: "splash.title",
  "splash-submit": "splash.submitTitle",
  "splash-mine": "splash.mineTitle",
  "splash-results": "splash.resultsTitle",
};
const screens = {
  splash: mountPond,
  "splash-submit": mountSubmit,
  "splash-mine": mountMine,
  "splash-results": mountResults,
};

export const isSplashRoute = (key: string): key is SplashRoute =>
  (SPLASH_ROUTES as readonly string[]).includes(key);

/**
 * SPLASH, the official auction app, as screens built into the shell. The shell
 * owns the frame, navigation, wallet and payment window; SPLASH reaches only
 * its own module API through the platform-scoped client.
 */
export function createSplash(options: {
  locale(): Locale;
  authenticated: boolean;
  api: ModuleApi;
  navigation: Navigation;
  openWallet(): void;
  connectedWallet(signal: AbortSignal): Promise<string | null>;
  pay(intent: unknown, signal: AbortSignal): Promise<PayResult>;
}) {
  const client = splashClient(options.api);
  return {
    title: (route: SplashRoute) => translator(options.locale())(titles[route]),
    /** Opens a SPLASH screen above the current one; Back and swipe return. */
    open(route: SplashRoute) {
      options.navigation.push({ key: route, edgeBack: true });
    },
    /** Mounts one screen into `container`; the returned function unmounts it. */
    mount(container: HTMLElement, route: SplashRoute): () => void {
      const lifecycle = new AbortController();
      const locale = options.locale();
      const stop = screens[route](container, {
        locale,
        text: translator(locale),
        client,
        authenticated: options.authenticated,
        navigation: options.navigation,
        signal: lifecycle.signal,
        open: (next) => {
          options.navigation.push({ key: next, edgeBack: true });
        },
        back: () => void options.navigation.back(),
        openWallet: () => {
          options.openWallet();
        },
        connectedWallet: (signal) => options.connectedWallet(signal),
        pay: (intent, signal) => options.pay(intent, signal),
      });
      return () => {
        lifecycle.abort();
        stop();
      };
    },
  };
}
