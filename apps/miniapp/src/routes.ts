import { Tabs, setWorkspaceIndex } from "../../../packages/ui/src/tabs.ts";
import type { MessageKey } from "../../../packages/i18n/src/index.ts";
import { Button, isSheetOpen } from "../../../packages/ui/src/index.ts";
import {
  GOVERNANCE_ROUTES,
  type GovernanceRoute,
} from "../../../modules/governance/ui/index.ts";
import {
  createNavigation,
  configurePageBack,
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
export type Route = "launcher" | "community" | Page;
export const home: NavEntry = { key: "launcher" };
const pages: readonly string[] = [
  "launcher",
  "profile",
  "community",
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
        .find((key): key is Route => pages.includes(key)) ?? "launcher",
    open(next: "profile" | "community" | "review" | "holders" | "collection") {
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
      navigation.top.edgeBack === true &&
      !isWorkspace(navigation.top.key),
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

const workspacePages = ["profile", "launcher", "community"] as const;
export const isWorkspace = (route: string) =>
  workspacePages.some((page) => page === route);
export function createWorkspace(
  screen: HTMLElement,
  options: {
    navigation: Navigation;
    route(): Route;
    text(key: MessageKey): string;
    enabled(): boolean;
    profile(): void;
  },
) {
  const select = (index: number) => {
    const next = workspacePages[index];
    if (!next) return;
    if (next !== options.route()) options.navigation.push({ key: next });
    if (next === "profile") options.profile();
  };
  let pending: (() => void) | undefined;
  let panels: HTMLElement[] = [];
  const track = document.createElement("div");
  track.className = "rada-workspace-track";
  const swipeOptions = {
    enabled: () =>
      isWorkspace(options.route()) &&
      options.navigation.top.key === options.route() &&
      !isSheetOpen() &&
      options.enabled(),
    index: () => workspacePages.findIndex((page) => page === options.route()),
    select,
    track: () => track,
    settled() {
      const draw = pending;
      pending = undefined;
      draw?.();
    },
  };
  let disposed = false;
  let motion:
    | ReturnType<
        (typeof import("../../../packages/ui/src/workspace-swipe.ts"))["workspaceSwipe"]
      >
    | undefined;
  const frame = requestAnimationFrame(() => {
    void import("./workspace-motion.ts")
      .then(({ installWorkspaceMotion }) => {
        if (!disposed) motion = installWorkspaceMotion(screen, swipeOptions);
      })
      .catch(() => {
        // Page buttons remain available if the optional gesture chunk fails.
      });
  });
  return {
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      motion?.dispose();
    },
    deferRender(draw: () => void) {
      if (!motion?.active()) return false;
      pending = draw;
      return true;
    },
    render(draw: (host: HTMLElement, route: Route) => void) {
      if (!panels.length) {
        panels = workspacePages.map(() => {
          const panel = document.createElement("div");
          panel.className = "rada-workspace-page";
          return panel;
        });
        track.replaceChildren(...panels);
      }
      workspacePages.forEach((page, index) => {
        const panel = panels[index];
        if (!panel) return;
        panel.inert = page !== options.route();
        panel.setAttribute("aria-hidden", String(panel.inert));
        // Keep secondary screen chunks out of the launcher's first paint.
        if (page === "community" && panel.inert) panel.replaceChildren();
        else draw(panel, page);
      });
      setWorkspaceIndex(
        track,
        workspacePages.findIndex((page) => page === options.route()),
      );
      screen.replaceChildren(track, this.nav());
    },
    nav: () =>
      Tabs({
        label: options.text("shell.navigation"),
        selected: options.route(),
        dots: true,
        tabs: workspacePages.map((id, index) => ({
          id,
          label: options.text(
            id === "profile"
              ? "shell.me"
              : id === "launcher"
                ? "shell.action"
                : "shell.us",
          ),
          onSelect: () => {
            select(index);
          },
        })),
      }),
  };
}

export function createSettingsAction(
  home: boolean,
  text: (key: MessageKey) => string,
  onClick: () => void,
) {
  const button = Button(text(home ? "shell.brand" : "shell.settings"), {
    ariaLabel: text("shell.settings"),
    ...(home ? {} : { icon: "settings" as const }),
    variant: "ghost",
    onClick,
  });
  button.dataset.focusKey = home ? "shell-settings-home" : "shell-settings";
  if (home) {
    button.classList.add("rada-os-wordmark");
    const name = document.createElement("b"),
      pill = document.createElement("em");
    name.textContent = text("shell.wordmark");
    pill.textContent = text("shell.os");
    button.replaceChildren(name, pill);
  }
  return button;
}

export function configureShellBack(
  screen: HTMLElement,
  key: string,
  navigation: Navigation,
) {
  const parent =
    key === "app"
      ? "launcher"
      : key !== "launcher"
        ? navigation.below?.key
        : undefined;
  configurePageBack(screen, {
    key,
    ...(parent
      ? {
          parent,
          back: () => {
            navigation.back();
          },
        }
      : {}),
    canSwipe: () => !isSheetOpen(),
  });
}
