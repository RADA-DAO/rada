import { settingsDialog } from "./settings.ts";
import * as payment from "./payment-copy.ts";
import { openAppPermissions, permissionLabel } from "./permissions.ts";
import { mountProfilePanel } from "./profile-panel.ts";
import type { OwnProfile } from "../../../packages/platform-sdk/src/index.ts";
import { mountReview } from "./review.ts";
import "@rada/ui/design-system.css";
import {
  applyTheme,
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
  Button,
  EmptyState,
  ErrorState,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import {
  initializePlatform,
  type NavEntry,
  configurePageBack,
  pageBackNavigation,
  createNavigation,
  installSwipeBack,
  setPageBackActive,
  deferPageBackRender,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  mountAppHost,
  type AppRelease,
} from "../../../packages/platform-sdk/src/app-host.ts";

let locale: Locale = navigator.language.startsWith("uk") ? "uk" : "en";
let route: "launcher" | "profile" | "review" = "launcher";
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
let sheet: HTMLDialogElement | undefined;
let activeAppDispose: (() => void) | undefined;
let pendingAppMount: AbortController | undefined;
let appHostGeneration = 0;
const home: NavEntry = { key: "launcher" };
const navigation = createNavigation(home);
const sheetEntry: NavEntry = {
  key: "sheet",
  stale: () => !sheet?.open,
  leave: () => {
    sheet?.close();
  },
};
const routeOf = () =>
  [...navigation.keys]
    .reverse()
    .find((key): key is "profile" | "review" =>
      ["profile", "review"].includes(key),
    ) ?? "launcher";
const openRoute = (next: "profile" | "review") => {
  navigation.push({ key: next, swipe: true });
};
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
root.className = "screen-wrap";
const screen = document.createElement("main");
screen.className = "screen";
root.append(screen);
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
      release,
      container,
      artifactOrigin,
      locale,
      consentCopy(permission, appName) {
        const label = permissionLabel(permission, text);
        return {
          title: text("shell.consentTitle"),
          description: t(locale, "shell.consentDescription", {
            app: appName,
            permission: label,
          }),
          allow: text("shell.consentAllow"),
          deny: text("shell.consentDeny"),
        };
      },
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
      onNavigateBack: () => {
        navigation.back();
      },
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
    !sheet?.open &&
    document.documentElement.dataset.appViewportReduced !== "true" &&
    navigation.top.swipe === true,
  back: () => {
    navigation.back();
  },
  preview: () => pageBackNavigation(screen).preview(),
  onActiveChange: (active) => {
    setPageBackActive(screen, active);
  },
});
function paragraph(key: MessageKey) {
  const node = document.createElement("p");
  node.textContent = text(key);
  return node;
}
function openSettings() {
  const opener = screen.querySelector<HTMLButtonElement>("header button");
  sheet = settingsDialog(
    locale,
    (value) => {
      locale = value;
      sheet?.close();
      render();
      openSettings();
    },
    (dialog) => {
      if (sheet === dialog) {
        sheet = undefined;
        navigation.drop("sheet");
      }
      if (!sheet?.open) opener?.focus();
    },
  );
  navigation.push(sheetEntry);
}
function showAppPermissions() {
  return openAppPermissions({
    text,
    platform,
    onOpen: (dialog) => {
      sheet = dialog;
      navigation.push(sheetEntry);
    },
    onClose: (dialog) => {
      if (sheet === dialog) {
        sheet = undefined;
        navigation.drop("sheet");
      }
    },
  });
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
    canSwipe: () => !sheet?.open,
  });
  const header = document.createElement("header");
  const brand = document.createElement("strong");
  brand.textContent = text("shell.brand");
  header.append(
    brand,
    Button(text("shell.settings"), { onClick: openSettings }),
  );
  const content = document.createElement("section");
  content.className = "workspace";
  const heading = document.createElement("h1");
  heading.textContent = text(
    route === "launcher"
      ? "shell.apps"
      : route === "review"
        ? "review.title"
        : "shell.profile",
  );
  content.append(heading);
  if (route === "launcher") {
    content.append(
      EmptyState({
        title: text("shell.emptyTitle"),
        message: text("shell.emptyDescription"),
      }),
    );
  } else if (route === "review") {
    const queue = document.createElement("div");
    content.append(queue);
    queue.dataset.reviewQueue = "true";
  } else {
    if (reviewAuthorized)
      content.append(
        Button(text("review.title"), {
          onClick: () => {
            openRoute("review");
          },
        }),
      );
    if (reviewProbeFailed)
      content.append(
        ErrorState({
          message: text("review.accessUnavailable"),
          retryLabel: text("common.retry"),
          onRetry: () => void loadProfile(),
        }),
      );
    content.append(paragraph(`shell.${profile}`));
    if (["private", "public"].includes(profile)) {
      const own = document.createElement("div");
      own.dataset.profileCollection = "true";
      const wallet = document.createElement("div");
      wallet.dataset.profileWallet = "true";
      content.append(
        own,
        wallet,
        paragraph(`shell.membership.${membership}`),
        Button(text("shell.appPermissions"), {
          onClick: () => void showAppPermissions(),
        }),
      );
    }
    if (profile === "guest")
      content.append(paragraph("shell.guestDescription"));
    if (profile === "expired" || profile === "unavailable")
      content.append(
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
  const footer = document.createElement("nav");
  footer.setAttribute("aria-label", text("shell.navigation"));
  footer.append(
    Button(text("shell.apps"), {
      onClick: () => {
        navigation.push(home);
      },
    }),
    Button(text("shell.profile"), {
      onClick: () => {
        openRoute("profile");
        if (platform.authenticatedLaunch) void loadProfile();
      },
    }),
  );
  for (const [index, node] of [...footer.children].entries())
    node.setAttribute(
      "aria-current",
      (route === "launcher" ? index === 0 : index === 1) ? "page" : "false",
    );
  screen.replaceChildren(header, content, footer);
  profileDispose = mountProfilePanel(content, {
    locale,
    selected: selectedFrog,
    platform,
    refresh: () => void loadProfile(),
  });
  const queue = content.querySelector<HTMLElement>("[data-review-queue]");
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
  const next = routeOf();
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
