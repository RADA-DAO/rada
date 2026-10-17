import { isSheetOpen } from "../../../packages/ui/src/index.ts";
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

type Page = "profile" | "review" | "holders" | SplashRoute;
export type Route = "launcher" | Page;
export const home: NavEntry = { key: "launcher" };
const pages: readonly string[] = [
  "profile",
  "review",
  "holders",
  ...SPLASH_ROUTES,
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
