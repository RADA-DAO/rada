import { createChunkLoader } from "./chunk-loader.ts";
import { createLazyScreen } from "./lazy-screen.ts";
import type { createSplashShell } from "./splash-shell.ts";
import {
  SPLASH_ROUTES,
  type SplashRoute,
} from "../../../modules/splash/ui/index.ts";
import {
  loadGovernance,
  isGovernanceRoute,
  type GovernanceRoute,
} from "../../../modules/governance/ui/index.ts";
import type {
  initializePlatform,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
const isSplashRoute = (route: string): route is SplashRoute =>
  (SPLASH_ROUTES as readonly string[]).includes(route);
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
  let splash: ReturnType<typeof createSplashShell> | undefined;
  let governance:
    | ReturnType<Awaited<ReturnType<typeof loadGovernance>>["createGovernance"]>
    | undefined;
  const loadDAO = createChunkLoader(loadGovernance, "governance");
  const loadSplash = createChunkLoader(
    () => import("./splash-shell.ts"),
    "splash",
  );
  const lazy = createLazyScreen();
  const open = (key: SplashRoute | GovernanceRoute) => {
    options.navigation.push({ key, edgeBack: true });
  };
  return {
    tiles: () => [
      {
        name: t(options.locale(), "splash.title"),
        onOpen: () => {
          open("splash");
        },
      },
      {
        name: t(options.locale(), "governance.title"),
        tier: "platform" as const,
        onOpen: () => {
          open("governance");
        },
      },
    ],
    render(
      host: HTMLElement,
      route: SplashRoute | GovernanceRoute,
      frame: { brand: string; actions: Node[] },
    ) {
      lazy.render(host, {
        locale: options.locale(),
        title: t(
          options.locale(),
          isGovernanceRoute(route) ? "governance.title" : "splash.title",
        ),
        ...frame,
        load: async () => {
          if (isGovernanceRoute(route)) {
            governance ??= (await loadDAO()).createGovernance({
              ...options,
              api: options.platform.moduleApi("governance"),
              authenticated: options.platform.authenticatedLaunch,
            });
            const app = governance;
            return () => {
              app.render(host, route, frame);
              return () => {
                app.dispose();
              };
            };
          }
          splash ??= (await loadSplash()).createSplashShell(options);
          const app = splash;
          return () => {
            app.render(host, route, frame);
            return () => {
              app.dispose();
            };
          };
        },
      });
    },
    dispose() {
      lazy.dispose();
    },
  };
}
