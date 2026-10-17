import { createSplashShell } from "./splash-shell.ts";
import {
  isSplashRoute,
  type SplashRoute,
} from "../../../modules/splash/ui/index.ts";
import {
  createGovernance,
  isGovernanceRoute,
  type GovernanceRoute,
} from "../../../modules/governance/ui/index.ts";
import type {
  initializePlatform,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
export const isBuiltInRoute = (
  route: string,
): route is SplashRoute | GovernanceRoute =>
  isSplashRoute(route) || isGovernanceRoute(route);
/** Module screens share only the shell frame and platform navigation lifecycle. */
export function createBuiltIns(options: {
  platform: ReturnType<typeof initializePlatform>;
  navigation: Navigation;
  locale(): Locale;
  membership(): string;
  openWallet(): void;
}) {
  const splash = createSplashShell(options);
  const governance = createGovernance({
    ...options,
    api: options.platform.moduleApi("governance"),
    authenticated: options.platform.authenticatedLaunch,
  });
  return {
    tiles: () => [
      { name: t(options.locale(), "splash.title"), onOpen: splash.open },
      {
        name: t(options.locale(), "governance.title"),
        tier: "platform" as const,
        onOpen: governance.open,
      },
    ],
    render(
      host: HTMLElement,
      route: SplashRoute | GovernanceRoute,
      frame: { brand: string; actions: Node[] },
    ) {
      if (isGovernanceRoute(route)) governance.render(host, route, frame);
      else splash.render(host, route, frame);
    },
    dispose() {
      splash.dispose();
      governance.dispose();
    },
  };
}
