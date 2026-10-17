import { onPageHide } from "./routes.ts";
import {
  profileStatus,
  showShellSettings,
  applyProfileTheme,
} from "./profile-status.ts";
import { createHoldersScreen } from "./holders-screen.ts";
import * as payment from "./payment-copy.ts";
import { openAppPermissions } from "./permissions.ts";
import { mountLazyProfile, createCollectionScreen } from "./profile-loader.ts";
import { mountReview } from "./review.ts";
import { createRoutes, home, installShellSwipe, type Route } from "./routes.ts";
import { createHome } from "./home.ts";
import { loadAppIcon } from "./app-icon.ts";
import "@rada/ui/design-system.css";
import {
  DEFAULT_THEME_BACKGROUND,
  Button,
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
  type OwnProfile,
  deferPageBackRender,
} from "../../../packages/platform-sdk/src/index.ts";
import { createAppRunner } from "./app-runner.ts";
import { createBuiltIns, isBuiltInRoute } from "./built-ins.ts";
let locale: Locale = navigator.language.startsWith("uk") ? "uk" : "en";
let route: Route = "launcher";
let reviewAuthorized = false;
let reviewProbeFailed = false;
let profileGeneration = 0;
let profile:
  "guest" | "loading" | "private" | "public" | "expired" | "unavailable" =
  "guest";
let selectedFrog: OwnProfile["profile"]["public"] = null;
const holders = createHoldersScreen();
const collection = createCollectionScreen();
let profileDispose: (() => void) | undefined,
  reviewDispose: (() => void) | undefined;
let membership: "member" | "not_member" | "unavailable" = "unavailable";
let settingsButton: HTMLElement | null = null;
const routes = createRoutes();
const { navigation } = routes;
const back = () => void navigation.back();
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing application root");
const screen = ScreenHost(root);
const text = (key: MessageKey, values?: Record<string, string>) =>
  t(locale, key, values);
const platform = initializePlatform({
  doneLabel: () => text("shell.done"),
  dismissLabel: () => text("shell.dismissKeyboard"),
  navigation,
  themeColor: DEFAULT_THEME_BACKGROUND,
  ...(typeof (import.meta.env.VITE_API_ORIGIN as unknown) === "string"
    ? { apiOrigin: import.meta.env.VITE_API_ORIGIN as string }
    : {}),
});
const runner = createAppRunner({
  navigation,
  platform,
  locale: () => locale,
  back,
  onClosed: () => {
    launcher.close();
  },
  onLeave: render,
});
const builtIns = createBuiltIns({
  membership: () => membership,
  platform,
  navigation,
  locale: () => locale,
  openWallet: () => {
    routes.open("profile");
    if (platform.authenticatedLaunch) void loadProfile();
  },
});
const dismissApp = runner.dismiss;
runner.expose();
const launcher = createHome({
  locale: () => locale,
  authenticated: platform.authenticatedLaunch,
  read: (signal) => platform.readPublishedApps(signal),
  loadIcon: loadAppIcon,
  mount: (app, container, origin) =>
    runner.mount(
      {
        appId: app.appId,
        manifest: app.manifest,
        artifactUrl: app.artifactUrl,
        artifactSha256: app.artifactSha256,
        grantedPermissions: app.grantedPermissions,
      },
      container,
      origin,
      true,
    ),
  render,
  builtIn: () => [
    ...builtIns.tiles(),
    {
      name: text("holders.title"),
      tier: "platform",
      onOpen: () => {
        routes.open("holders");
      },
    },
  ],
});
applyProfileTheme(null);
const swipe = installShellSwipe(
  screen,
  navigation,
  () => payment.paymentBusy,
  back,
);
function showSettings() {
  showShellSettings(locale, navigation, settingsButton, changeLocale);
}
function changeLocale(value: Locale) {
  locale = value;
  render();
  showSettings();
}
async function loadProfile(initial = false) {
  const generation = ++profileGeneration;
  const stale = () =>
    generation !== profileGeneration || (!initial && route !== "profile");
  reviewAuthorized = false;
  reviewProbeFailed = false;
  profile = "loading";
  selectedFrog = null;
  membership = "unavailable";
  render();
  try {
    const ownProfile = await platform.readOwnProfile();
    if (stale()) return;
    profile = ownProfile?.profile.visibility ?? "guest";
    selectedFrog = ownProfile?.profile.public ?? null;
    applyProfileTheme(selectedFrog);
    membership = ownProfile?.membership.status ?? "unavailable";
  } catch (error) {
    if (stale()) return;
    membership = "unavailable";
    profile =
      error instanceof Error && error.message === "expired"
        ? "expired"
        : "unavailable";
  }
  if (stale()) return;
  if (initial) {
    render();
    return;
  }
  if (platform.authenticatedLaunch && ["private", "public"].includes(profile)) {
    try {
      await platform.readReviewQueue();
      if (stale()) return;
      reviewAuthorized = true;
    } catch (error) {
      if (stale()) return;
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
  builtIns.dispose();
  holders.dispose();
  collection.dispose();
  document.documentElement.lang = locale;
  document.title = text("shell.brand");
  const running = route === "launcher" ? launcher.running : undefined;
  configurePageBack(screen, {
    key: running ? "app" : route,
    ...(running
      ? { parent: route, back: () => void navigation.back() }
      : route !== "launcher" && navigation.below
        ? {
            parent: navigation.below.key,
            back: () => {
              navigation.back();
            },
          }
        : {}),
    canSwipe: () => !isSheetOpen(),
  });
  settingsButton = Button(
    text(route === "launcher" ? "shell.brand" : "shell.settings"),
    {
      ariaLabel: text("shell.settings"),
      ...(route === "launcher" ? {} : { icon: "settings" as const }),
      variant: "ghost",
      onClick: showSettings,
    },
  );
  if (isBuiltInRoute(route)) {
    builtIns.render(screen, route, {
      brand: text("shell.brand"),
      actions: [settingsButton],
    });
    return;
  }
  if (route === "collection" || route === "frog") {
    collection.render(screen, {
      locale,
      platform,
      navigation,
      selected: selectedFrog?.frog_id ?? null,
      frogId: route === "frog" ? routes.frogId() : null,
      actions: [settingsButton],
      openFrog: (id) => {
        routes.openFrog(id);
      },
      refresh: () => void loadProfile(),
    });
    return;
  }
  if (route === "holders") {
    const actions = [settingsButton];
    holders.render(screen, {
      locale,
      title: text("holders.title"),
      brand: text("shell.brand"),
      actions,
      viewerFrogId: selectedFrog?.frog_id ?? null,
      read: (token, cursor, signal) =>
        platform.readHolders(token, cursor, signal),
    });
    return;
  }
  const content: Node[] = [];
  if (running) {
    screen.replaceChildren(
      Screen({
        title: running.name,
        brand: text("shell.brand"),
        children: [running.frame],
      }),
    );
    return;
  }
  if (route === "launcher") content.push(...launcher.content());
  else if (route === "review") {
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
        onClick: () =>
          void openAppPermissions({
            text,
            platform,
            navigation,
            opener: permissions,
          }),
      });
      content.push(
        own,
        wallet,
        Text(text(`shell.membership.${membership}`)),
        permissions,
      );
    }
    content.push(...profileStatus(locale, profile, () => void loadProfile()));
  }
  const view = Screen({
    title: text(
      route === "launcher"
        ? "shell.apps"
        : route === "review"
          ? "review.title"
          : "shell.profile",
    ),
    ...(route === "launcher"
      ? { titleHidden: true }
      : { brand: text("shell.brand") }),
    ...(route === "launcher"
      ? {
          top: launcher.identity({
            authenticated: platform.authenticatedLaunch,
            visibility: profile,
            frog: selectedFrog,
          }),
        }
      : {}),
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
  profileDispose = mountLazyProfile(view, {
    locale,
    selected: selectedFrog,
    openCollection: () => {
      routes.open("collection");
    },
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
void launcher.load();
if (platform.authenticatedLaunch) void loadProfile(true);
onPageHide(() => {
  profileGeneration++;
  launcher.dispose();
  holders.dispose();
  collection.dispose();
  profileDispose?.();
  reviewDispose?.();
  builtIns.dispose();
  dismissApp();
  swipe.dispose();
  platform.dispose();
  navigation.dispose();
});
