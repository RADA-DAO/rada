import {
  createNavigation,
  type NavEntry,
} from "../../../packages/platform-sdk/src/index.ts";

export type Route = "launcher" | "profile" | "review";
export const home: NavEntry = { key: "launcher" };

/** Screens are stack entries; sheets and running apps sit above them. */
export function createRoutes() {
  const navigation = createNavigation(home);
  return {
    navigation,
    current: (): Route =>
      [...navigation.keys]
        .reverse()
        .find((key): key is "profile" | "review" =>
          ["profile", "review"].includes(key),
        ) ?? "launcher",
    open(next: "profile" | "review") {
      navigation.push({ key: next, edgeBack: true });
    },
  };
}
