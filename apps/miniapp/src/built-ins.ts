import { createChunkLoader } from "./chunk-loader.ts";
import {
  REPUTATION_ROUTES,
  loadReputation,
  type ReputationRoute,
} from "../../../modules/reputation/ui/index.ts";
import { createLazyScreen } from "./lazy-screen.ts";
import type { createSplashShell } from "./splash-shell.ts";
import {
  SPLASH_ROUTES,
  type SplashRoute,
} from "../../../modules/splash/ui/index.ts";
import {
  type loadGovernance,
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
const isReputationRoute = (route: string): route is ReputationRoute =>
  (REPUTATION_ROUTES as readonly string[]).includes(route);
export const isBuiltInRoute = (
  route: string,
): route is SplashRoute | GovernanceRoute | ReputationRoute | "treasury" =>
  route === "treasury" ||
  isSplashRoute(route) ||
  isGovernanceRoute(route) ||
  isReputationRoute(route);
/** Module screens share only the shell frame and platform navigation lifecycle. */
export function createBuiltIns(options: {
  platform: ReturnType<typeof initializePlatform>;
  navigation: Navigation;
  locale(): Locale;
  membership(): string;
  openWallet(): void;
  openHolders(): void;
}) {
  let splash: ReturnType<typeof createSplashShell> | undefined;
  let reputation:
    | ReturnType<Awaited<ReturnType<typeof loadReputation>>["createReputation"]>
    | undefined;
  let governance:
    | ReturnType<Awaited<ReturnType<typeof loadGovernance>>["createGovernance"]>
    | undefined;
  const loadScreens = () => import("./desktop-screens.ts");
  const loadDAO = createChunkLoader(loadScreens, "governance");
  const loadSplash = createChunkLoader(loadScreens, "splash");
  const loadTreasury = createChunkLoader(loadScreens, "treasury");
  const loadReputationScreen = createChunkLoader(loadReputation, "reputation");
  const lazy = createLazyScreen();
  const open = (
    key: SplashRoute | GovernanceRoute | ReputationRoute | "treasury",
  ) => {
    options.navigation.push({ key, edgeBack: true });
  };
  return {
    tiles: () => [
      ...(import.meta.env.VITE_REPUTATION_ENABLED === "true"
        ? [
            {
              id: "builtin:tasks",
              name: t(options.locale(), "reputation.tasksTitle"),
              tier: "platform" as const,
              onOpen: () => {
                open("tasks");
              },
            },
            {
              id: "builtin:reputation",
              name: t(options.locale(), "reputation.title"),
              tier: "platform" as const,
              onOpen: () => {
                open("reputation");
              },
            },
          ]
        : []),
      {
        id: "builtin:splash",
        iconUrl: "/apps/splash.webp",
        name: t(options.locale(), "splash.title"),
        onOpen: () => {
          open("splash");
        },
      },
      {
        id: "builtin:governance",
        name: t(options.locale(), "governance.title"),
        tier: "platform" as const,
        onOpen: () => {
          open("governance");
        },
      },
      {
        id: "builtin:treasury",
        iconUrl: "/apps/treasury.webp",
        name: t(options.locale(), "treasury.title"),
        tier: "platform" as const,
        onOpen: () => {
          open("treasury");
        },
      },
      {
        id: "builtin:holders",
        name: t(options.locale(), "holders.title"),
        tier: "platform" as const,
        onOpen: () => {
          options.openHolders();
        },
      },
    ],
    render(
      host: HTMLElement,
      route: SplashRoute | GovernanceRoute | ReputationRoute | "treasury",
      frame: { brand: string; actions: Node[] },
    ) {
      lazy.render(host, {
        locale: options.locale(),
        title: t(
          options.locale(),
          isReputationRoute(route)
            ? "reputation.title"
            : route === "treasury"
              ? "treasury.title"
              : isGovernanceRoute(route)
                ? "governance.title"
                : "splash.title",
        ),
        ...frame,
        load: async () => {
          if (isReputationRoute(route)) {
            reputation ??= (await loadReputationScreen()).createReputation({
              api: options.platform.moduleApi("reputation"),
              navigation: options.navigation,
              locale: () => options.locale(),
              authenticated: options.platform.authenticatedLaunch,
              actorKey: options.platform.ownSubject,
            });
            const app = reputation;
            return () => {
              app.render(host, route, frame);
              return () => {
                app.dispose();
              };
            };
          }
          if (route === "treasury") {
            const { showTreasury } = await loadTreasury();
            return () =>
              showTreasury(host, {
                ...frame,
                locale: options.locale(),
                api: options.platform.moduleApi("treasury"),
                authenticated: options.platform.authenticatedLaunch,
                openDecision: async (id: string) => {
                  governance ??= (await loadDAO()).createGovernance({
                    ...options,
                    api: options.platform.moduleApi("governance"),
                    authenticated: options.platform.authenticatedLaunch,
                  });
                  if (options.navigation.top.key === "treasury")
                    governance.selectProposal(id);
                },
              });
          }
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
