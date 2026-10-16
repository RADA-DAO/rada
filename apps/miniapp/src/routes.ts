import {
  createNavigation,
  type NavEntry,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  SPLASH_ROUTES,
  type SplashRoute,
} from "../../../modules/splash/ui/index.ts";

type Page = "profile" | "review" | SplashRoute;
export type Route = "launcher" | Page;
export const home: NavEntry = { key: "launcher" };
const pages: readonly string[] = ["profile", "review", ...SPLASH_ROUTES];

/** Screens are stack entries; sheets and running apps sit above them. */
export function createRoutes() {
  const navigation = createNavigation(home);
  return {
    navigation,
    current: (): Route =>
      [...navigation.keys]
        .reverse()
        .find((key): key is Page => pages.includes(key)) ?? "launcher",
    open(next: "profile" | "review") {
      navigation.push({ key: next, edgeBack: true });
    },
  };
}
