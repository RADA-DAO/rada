import { openSettings } from "./settings.ts";
import * as payment from "./payment-copy.ts";
import { consentCopy, openAppPermissions } from "./permissions.ts";
import { mountProfilePanel } from "./profile-panel.ts";
import type { OwnProfile } from "../../../packages/platform-sdk/src/index.ts";
import { mountReview } from "./review.ts";
import { createRoutes, home, type Route } from "./routes.ts";
import "@rada/ui/design-system.css";
import {
  applyTheme,
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
  Button,
  EmptyState,
  ErrorState,
  Group,
  isSheetOpen,
  Screen,
  ScreenHost,
  Tabs,
  Text,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import {
  initializePlatform,
  configurePageBack,
  pageBackNavigation,
  installSwipeBack,
  setPageBackActive,
  deferPageBackRender,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  mountAppHost,
  type AppRelease,
} from "../../../packages/platform-sdk/src/app-host.ts";

let locale: Locale = navigator.language.startsWith("uk") ? "uk" : "en";
let route: Route = "launcher";
let reviewAuthorized = false;
let reviewProbeFailed = false;
let profileGeneration = 0;
let reviewDispose: (() => void) | undefined;
let profile:
  "guest" | "loading" | "private" | "public" | "expired" | "unavailable" =
  "guest";
let selectedFrog: OwnProfile["profile"]["public"] = null;
let profileDispose: (() => void) | undefined;
let membership: "member" | "not_member" | "unavailable" = "unavailable";
let settingsButton: HTMLElement | null = null;
let activeAppDispose: (() => void) | undefined;
let pendingAppMount: AbortController | undefined;
let appHostGeneration = 0;
const routes = createRoutes();
const { navigation } = routes;
const back = () => void navigation.back();
function dismissApp() {
  closeActiveApp();
  navigation.drop("app");
}
function closeActiveApp() {
  appHostGeneration++;
  pendingAppMount?.abort();
  pendingAppMount = undefined;
  activeAppDispose?.();
  activeAppDispose = undefined;
}
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing application root");
const screen = ScreenHost(root);
const text = (key: MessageKey) => t(locale, key);
const platform = initializePlatform({
  doneLabel: () => text("shell.done"),
  dismissLabel: () => text("shell.dismissKeyboard"),
  navigation,
  themeColor: DEFAULT_THEME_BACKGROUND,
  ...(typeof (import.meta.env.VITE_API_ORIGIN as unknown) === "string"
    ? { apiOrigin: import.meta.env.VITE_API_ORIGIN as string }
    : {}),
});
window.RadaAppHost = Object.freeze({
  async mount(
    release: AppRelease,
    container: HTMLElement,
    artifactOrigin: string,
  ) {
    closeActiveApp();
    const generation = appHostGeneration;
    const controller = new AbortController();
    pendingAppMount = controller;
    navigation.push({
      key: "app",
      leave: () => {
        closeActiveApp();
        render();
      },
    });
    const dispose = await mountAppHost({
      signal: controller.signal,
      navigation,
      release,
      container,
      artifactOrigin,
      locale,
      consentCopy: (permission, appName) =>
        consentCopy(locale, permission, appName),
      readConsent: (appId, permission) =>
        platform.readAppConsent(appId, permission),
      writeConsent: (appId, permission, granted) =>
        platform.writeAppConsent(appId, permission, granted),
      ownSubject: async () =>
        (await platform.readOwnProfile())?.subject_id ?? null,
      readWalletAddress: (appId, signal) =>
        platform.readAppWalletAddress(appId, signal),
      readWalletBalances: (appId, signal) =>
        platform.readAppWalletBalances(appId, signal),
      ...payment.paymentHostAdapter(platform, locale, payment.setPaymentBusy),
      onNavigateBack: back,
    }).catch((error: unknown) => {
      if (pendingAppMount === controller) {
        pendingAppMount = undefined;
        navigation.drop("app");
      }
      throw error;
    });
    if (generation !== appHostGeneration) {
      dispose();
      throw new Error("app_replaced");
    }
    activeAppDispose = dispose;
    pendingAppMount = undefined;
    return () => {
      if (activeAppDispose !== dispose) return;
      dismissApp();
    };
  },
});
applyTheme(document.documentElement, compileTheme(DEFAULT_THEME_BACKGROUND));
const swipe = installSwipeBack(screen, {
  canStart: () =>
    !payment.paymentBusy &&
    !isSheetOpen() &&
    document.documentElement.dataset.appViewportReduced !== "true" &&
    navigation.top.edgeBack === true,
  back,
  preview: () => pageBackNavigation(screen).preview(),
  onActiveChange: (active) => {
    setPageBackActive(screen, active);
  },
});
function showSettings() {
  openSettings({
    locale,
    navigation,
    opener: settingsButton,
    change: (value) => {
      locale = value;
      render();
      showSettings();
    },
  });
}
function showAppPermissions(opener: HTMLElement | null) {
  return openAppPermissions({ text, platform, navigation, opener });
}
const onProfileRoute = () => route === "profile";
async function loadProfile() {
  const generation = ++profileGeneration;
  reviewAuthorized = false;
  reviewProbeFailed = false;
  profile = "loading";
  selectedFrog = null;
  membership = "unavailable";
  render();
  try {
    const ownProfile = await platform.readOwnProfile();
    if (generation !== profileGeneration || !onProfileRoute()) return;
    profile = ownProfile?.profile.visibility ?? "guest";
    selectedFrog = ownProfile?.profile.public ?? null;
    applyTheme(
      document.documentElement,
      compileTheme(
        selectedFrog?.background_color ?? DEFAULT_THEME_BACKGROUND,
        selectedFrog?.accent_color,
      ),
    );
    membership = ownProfile?.membership.status ?? "unavailable";
  } catch (error) {
    if (generation !== profileGeneration || !onProfileRoute()) return;
    membership = "unavailable";
    profile =
      error instanceof Error && error.message === "expired"
        ? "expired"
        : "unavailable";
  }
  if (generation !== profileGeneration || !onProfileRoute()) return;
  if (platform.authenticatedLaunch && ["private", "public"].includes(profile)) {
    try {
      await platform.readReviewQueue();
      if (generation !== profileGeneration || !onProfileRoute()) return;
      reviewAuthorized = true;
    } catch (error) {
      if (generation !== profileGeneration || !onProfileRoute()) return;
      reviewProbeFailed = !(
        error instanceof Error &&
        ["forbidden", "expired", "not_available"].includes(error.message)
      );
    }
  }
  render();
}
function render() {
  if (deferPageBackRender(screen, render)) return;
  reviewDispose?.();
  reviewDispose = undefined;
  profileDispose?.();
  profileDispose = undefined;
  document.documentElement.lang = locale;
  document.title = text("shell.brand");
  configurePageBack(screen, {
    key: route,
    ...(route !== "launcher" && navigation.below
      ? {
          parent: navigation.below.key,
          back: () => {
            navigation.back();
          },
        }
      : {}),
    canSwipe: () => !isSheetOpen(),
  });
  settingsButton = Button(text("shell.settings"), {
    variant: "ghost",
    onClick: showSettings,
  });
  const content: Node[] = [];
  if (route === "launcher") {
    content.push(
      EmptyState({
        title: text("shell.emptyTitle"),
        message: text("shell.emptyDescription"),
      }),
    );
  } else if (route === "review") {
    const queue = Group();
    queue.dataset.reviewQueue = "true";
    content.push(queue);
  } else {
    if (reviewAuthorized)
      content.push(
        Button(text("review.title"), {
          onClick: () => {
            routes.open("review");
          },
        }),
      );
    if (reviewProbeFailed)
      content.push(
        ErrorState({
          message: text("review.accessUnavailable"),
          retryLabel: text("common.retry"),
          onRetry: () => void loadProfile(),
        }),
      );
    content.push(Text(text(`shell.${profile}`)));
    if (["private", "public"].includes(profile)) {
      const own = Group();
      own.dataset.profileCollection = "true";
      const wallet = Group();
      wallet.dataset.profileWallet = "true";
      const permissions = Button(text("shell.appPermissions"), {
        onClick: () => void showAppPermissions(permissions),
      });
      content.push(
        own,
        wallet,
        Text(text(`shell.membership.${membership}`)),
        permissions,
      );
    }
    if (profile === "guest") content.push(Text(text("shell.guestDescription")));
    if (profile === "expired" || profile === "unavailable")
      content.push(
        ErrorState({
          message: text(
            profile === "expired"
              ? "shell.expiredDescription"
              : "shell.unavailableDescription",
          ),
          retryLabel: text("common.retry"),
          onRetry: () => void loadProfile(),
        }),
      );
  }
  const view = Screen({
    title: text(
      route === "launcher"
        ? "shell.apps"
        : route === "review"
          ? "review.title"
          : "shell.profile",
    ),
    brand: text("shell.brand"),
    actions: [settingsButton],
    children: content,
    footer: Tabs({
      label: text("shell.navigation"),
      selected: route === "launcher" ? "apps" : "profile",
      tabs: [
        {
          id: "apps",
          label: text("shell.apps"),
          onSelect: () => {
            navigation.push(home);
          },
        },
        {
          id: "profile",
          label: text("shell.profile"),
          onSelect: () => {
            routes.open("profile");
            if (platform.authenticatedLaunch) void loadProfile();
          },
        },
      ],
    }),
  });
  screen.replaceChildren(view);
  profileDispose = mountProfilePanel(view, {
    locale,
    selected: selectedFrog,
    platform,
    refresh: () => void loadProfile(),
  });
  const queue = view.querySelector<HTMLElement>("[data-review-queue]");
  if (queue)
    reviewDispose = mountReview(queue, {
      locale,
      read: (signal) => platform.readReviewQueue(signal),
      decide: (appId, versionId, decision, reason, signal) =>
        platform.reviewAppVersion(appId, versionId, decision, reason, signal),
      closePreview: dismissApp,
    });
}
navigation.setGuard(() => payment.paymentBusy);
navigation.subscribe(() => {
  const next = routes.current();
  if (next === route) return;
  route = next;
  render();
});
render();
window.addEventListener(
  "pagehide",
  (event) => {
    if (event.persisted) return;
    profileGeneration++;
    profileDispose?.();
    reviewDispose?.();
    dismissApp();
    swipe.dispose();
    platform.dispose();
    navigation.dispose();
  },
  { once: true },
);
