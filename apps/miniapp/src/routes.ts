import { isSheetOpen } from "../../../packages/ui/src/index.ts";
import {
  GOVERNANCE_ROUTES,
  type GovernanceRoute,
} from "../../../modules/governance/ui/index.ts";
import {
  createNavigation,
  installSwipeBack,
  pageBackNavigation,
  setPageBackActive,
  type Navigation,
  type NavEntry,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  SPLASH_ROUTES,
  type SplashRoute,
} from "../../../modules/splash/ui/index.ts";

type Page =
  | "collection"
  | "frog"
  | "profile"
  | "review"
  | "treasury"
  | "holders"
  | SplashRoute
  | GovernanceRoute;
export type Route = "launcher" | Page;
export const home: NavEntry = { key: "launcher" };
const pages: readonly string[] = [
  "profile",
  "collection",
  "frog",
  "review",
  "holders",
  "treasury",
  ...SPLASH_ROUTES,
  ...GOVERNANCE_ROUTES,
];

/** Screens are stack entries; sheets and running apps sit above them. */
export function createRoutes() {
  const navigation = createNavigation(home);
  let frogId: string | null = null;
  return {
    navigation,
    frogId: () => frogId,
    openFrog(id: string) {
      frogId = id;
      navigation.push({ key: "frog", edgeBack: true });
    },
    current: (): Route =>
      [...navigation.keys]
        .reverse()
        .find((key): key is Page => pages.includes(key)) ?? "launcher",
    open(next: "profile" | "review" | "holders" | "collection") {
      navigation.push({ key: next, edgeBack: true });
    },
  };
}

export function installShellSwipe(
  screen: HTMLElement,
  navigation: Navigation,
  busy: () => boolean,
  back: () => void,
) {
  return installSwipeBack(screen, {
    canStart: () =>
      !busy() &&
      !isSheetOpen() &&
      document.documentElement.dataset.appViewportReduced !== "true" &&
      navigation.top.edgeBack === true,
    back,
    preview: () => pageBackNavigation(screen).preview(),
    onActiveChange: (active) => {
      setPageBackActive(screen, active);
    },
  });
}

/** Keep bfcache restores live, and dispose resources on a final page departure. */
export function onPageHide(dispose: () => void): void {
  window.addEventListener(
    "pagehide",
    (event) => {
      if (!event.persisted) dispose();
    },
    { once: true },
  );
}
