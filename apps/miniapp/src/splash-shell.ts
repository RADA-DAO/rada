import * as payment from "./payment-copy.ts";
import { Group, Screen } from "../../../packages/ui/src/index.ts";
import type { Locale } from "../../../packages/i18n/src/index.ts";
import type {
  initializePlatform,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  createSplash,
  SPLASH_APP_ID,
  type SplashRoute,
} from "../../../modules/splash/ui/index.ts";

/**
 * SPLASH inside the shell: its screens get the platform frame, the module's
 * own API, the viewer's connected wallet and the platform payment window. The
 * shell keeps the payment copy and blocks Back while a payment is open.
 */
export function createSplashShell(options: {
  platform: ReturnType<typeof initializePlatform>;
  navigation: Navigation;
  locale(): Locale;
  openWallet(): void;
}) {
  const { platform } = options;
  const splash = createSplash({
    locale: () => options.locale(),
    authenticated: platform.authenticatedLaunch,
    api: platform.moduleApi("splash"),
    navigation: options.navigation,
    openWallet: () => {
      options.openWallet();
    },
    connectedWallet: (signal) => platform.connectedWallet(signal),
    pay: async (intent, signal) => {
      payment.setPaymentBusy(true);
      try {
        return await platform.payIntent(
          SPLASH_APP_ID,
          intent,
          payment.paymentCopy(options.locale()),
          signal,
        );
      } finally {
        payment.setPaymentBusy(false);
      }
    },
  });
  let dispose: (() => void) | undefined;
  return {
    open: () => {
      splash.open("splash");
    },
    /** Replaces `host` with the SPLASH screen for `route`. */
    render(
      host: HTMLElement,
      route: SplashRoute,
      frame: { brand: string; actions: Node[] },
    ) {
      const content = Group();
      host.replaceChildren(
        Screen({
          title: splash.title(route),
          brand: frame.brand,
          actions: frame.actions,
          children: [content],
        }),
      );
      dispose = splash.mount(content, route);
    },
    dispose() {
      dispose?.();
      dispose = undefined;
    },
  };
}
