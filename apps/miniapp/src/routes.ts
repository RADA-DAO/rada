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

<<<<<<< HEAD
type Page = "profile" | "review" | "holders" | SplashRoute;
=======
type Page = "profile" | "review" | SplashRoute | GovernanceRoute;
>>>>>>> 5ace018 (feat(miniapp): governance screens for advisory votes and steward decisions)
export type Route = "launcher" | Page;
export const home: NavEntry = { key: "launcher" };
const pages: readonly string[] = [
  "profile",
  "review",
<<<<<<< HEAD
  "holders",
  ...SPLASH_ROUTES,
=======
  ...SPLASH_ROUTES,
  ...GOVERNANCE_ROUTES,
>>>>>>> 5ace018 (feat(miniapp): governance screens for advisory votes and steward decisions)
];

/** Screens are stack entries; sheets and running apps sit above them. */
export function createRoutes() {
  const navigation = createNavigation(home);
  return {
    navigation,
    current: (): Route =>
      [...navigation.keys]
        .reverse()
        .find((key): key is Page => pages.includes(key)) ?? "launcher",
    open(next: "profile" | "review" | "holders") {
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
