import "../../../packages/ui/src/design-system.css";
import "./shell.css";
import {
  applyTheme,
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
  Button,
  EmptyState,
  ErrorState,
  Sheet,
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

declare global {
  interface Window {
    RadaAppHost?: {
      mount(
        release: AppRelease,
        container: HTMLElement,
        artifactOrigin: string,
      ): Promise<() => void>;
    };
  }
}

let locale: Locale = navigator.language.startsWith("uk") ? "uk" : "en";
let route: "launcher" | "profile" = "launcher";
let profile: "guest" | "loading" | "private" | "expired" | "unavailable" =
  "guest";
let membership: "member" | "not_member" | "unavailable" = "unavailable";
let sheet: HTMLDialogElement | undefined;
let activeAppDispose: (() => void) | undefined;
let pendingAppMount: AbortController | undefined;
let appHostGeneration = 0;
function closeActiveApp() {
  appHostGeneration++;
  pendingAppMount?.abort();
  pendingAppMount = undefined;
  activeAppDispose?.();
  activeAppDispose = undefined;
}
const permissionKeys = {
  "telegram.username.read": "shell.permissions.telegramUsername",
  "wallet.address.read": "shell.permissions.walletAddress",
  "wallet.balances.read": "shell.permissions.walletBalances",
  "jpegpe.collection.read": "shell.permissions.frogCollection",
  "notifications.send": "shell.permissions.notifications",
} as const satisfies Record<string, MessageKey>;
function permissionLabel(capability: string): string {
  return capability in permissionKeys
    ? text(permissionKeys[capability as keyof typeof permissionKeys])
    : "";
}
const root = document.querySelector<HTMLElement>("#app")!;
root.className = "screen-wrap";
const screen = document.createElement("main");
screen.className = "screen";
root.append(screen);
const text = (key: MessageKey) => t(locale, key);
const back = () => {
  if (activeAppDispose || pendingAppMount) {
    closeActiveApp();
    route = "launcher";
    render();
    return;
  }
  if (sheet?.open) {
    sheet.close();
    return;
  }
  pageBackNavigation(screen).back();
};
const platform = initializePlatform({
  doneLabel: () => text("shell.done"),
  dismissLabel: () => text("shell.dismissKeyboard"),
  onBack: back,
  themeColor: DEFAULT_THEME_BACKGROUND,
  apiOrigin: import.meta.env.VITE_API_ORIGIN,
});
// The launcher will receive release records from the registry. Only same-origin
// shell code may call this adapter; a manifest cannot supply grantedPermissions.
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
    platform.setBackVisible(true);
    const dispose = await mountAppHost({
      signal: controller.signal,
      release,
      container,
      artifactOrigin,
      locale,
      consentCopy(permission, appName) {
        const label = permissionLabel(permission);
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
      onNavigateBack: back,
    }).catch((error: unknown) => {
      if (pendingAppMount === controller) {
        pendingAppMount = undefined;
        platform.setBackVisible(route === "profile");
      }
      throw error;
    });
    if (generation !== appHostGeneration) {
      dispose();
      throw new Error("app_replaced");
    }
    activeAppDispose = dispose;
    pendingAppMount = undefined;
    platform.setBackVisible(true);
    return () => {
      if (activeAppDispose !== dispose) return;
      closeActiveApp();
      platform.setBackVisible(route === "profile");
    };
  },
});
applyTheme(document.documentElement, compileTheme(DEFAULT_THEME_BACKGROUND));
const swipe = installSwipeBack(screen, {
  canStart: () =>
    !sheet?.open &&
    document.documentElement.dataset.appViewportReduced !== "true" &&
    pageBackNavigation(screen).canSwipe(),
  back,
  preview: () => pageBackNavigation(screen).preview(),
  onActiveChange: (active) => setPageBackActive(screen, active),
});
function paragraph(key: MessageKey) {
  const node = document.createElement("p");
  node.textContent = text(key);
  return node;
}
function openSettings() {
  const opener = screen.querySelector<HTMLButtonElement>("header button");
  const label = document.createElement("label");
  label.textContent = text("shell.language");
  const select = document.createElement("select");
  select.setAttribute("aria-label", text("shell.language"));
  for (const value of ["en", "uk"] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text(
      value === "en" ? "shell.english" : "shell.ukrainian",
    );
    select.append(option);
  }
  select.value = locale;
  select.onchange = () => {
    locale = select.value as Locale;
    sheet?.close();
    render();
    openSettings();
  };
  label.append(select);
  const dialog = Sheet({
    title: text("shell.settings"),
    closeLabel: text("common.close"),
    children: [label],
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (sheet === dialog) sheet = undefined;
      platform.setBackVisible(Boolean(sheet?.open) || route === "profile");
      if (!sheet?.open) opener?.focus();
    },
    { once: true },
  );
  sheet = dialog;
  document.body.append(dialog);
  dialog.showModal();
  platform.setBackVisible(true);
}
async function openAppPermissions() {
  const title = text("shell.appPermissions");
  const content = document.createElement("div");
  content.append(paragraph("common.loading"));
  const dialog = Sheet({
    title,
    closeLabel: text("common.close"),
    children: [content],
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      if (sheet === dialog) sheet = undefined;
      platform.setBackVisible(route === "profile");
    },
    { once: true },
  );
  sheet = dialog;
  document.body.append(dialog);
  dialog.showModal();
  platform.setBackVisible(true);
  async function refresh() {
    try {
      const items = await platform.readAppConsents();
      if (!dialog.open) return;
      content.replaceChildren();
      if (!items.length) content.append(paragraph("shell.noAppPermissions"));
      for (const item of items) {
        const label = permissionLabel(item.capability);
        if (!label) continue;
        const row = document.createElement("p");
        row.textContent = `${item.app_id}: ${label} `;
        row.append(
          Button(text("shell.revokePermission"), {
            onClick: () => {
              void platform
                .writeAppConsent(item.app_id, item.capability, false)
                .then(refresh)
                .catch(() => {
                  content.replaceChildren(
                    paragraph("shell.unavailableDescription"),
                  );
                });
            },
          }),
        );
        content.append(row);
      }
    } catch {
      if (dialog.open)
        content.replaceChildren(paragraph("shell.unavailableDescription"));
    }
  }
  await refresh();
}
async function loadProfile() {
  profile = "loading";
  membership = "unavailable";
  render();
  try {
    const ownProfile = await platform.readOwnProfile();
    profile = ownProfile ? "private" : "guest";
    membership = ownProfile?.membership.status ?? "unavailable";
  } catch (error) {
    membership = "unavailable";
    profile =
      error instanceof Error && error.message === "expired"
        ? "expired"
        : "unavailable";
  }
  render();
}
function render() {
  if (deferPageBackRender(screen, render)) return;
  document.documentElement.lang = locale;
  document.title = text("shell.brand");
  configurePageBack(screen, {
    key: route,
    parent: route === "profile" ? "launcher" : undefined,
    back:
      route === "profile"
        ? () => {
            route = "launcher";
            render();
          }
        : undefined,
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
    route === "launcher" ? "shell.apps" : "shell.profile",
  );
  content.append(heading);
  if (route === "launcher") {
    content.append(
      EmptyState({
        title: text("shell.emptyTitle"),
        message: text("shell.emptyDescription"),
      }),
    );
  } else {
    content.append(paragraph(`shell.${profile}`));
    if (profile === "private")
      content.append(
        paragraph("shell.privateDescription"),
        paragraph(`shell.membership.${membership}`),
        Button(text("shell.appPermissions"), {
          onClick: () => void openAppPermissions(),
        }),
      );
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
    content.append(Button(text("shell.back"), { onClick: back }));
  }
  const footer = document.createElement("nav");
  footer.setAttribute("aria-label", text("shell.navigation"));
  footer.append(
    Button(text("shell.apps"), {
      onClick: () => {
        route = "launcher";
        render();
      },
    }),
    Button(text("shell.profile"), {
      onClick: () => {
        route = "profile";
        render();
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
  platform.setBackVisible(route === "profile");
}
render();
window.addEventListener(
  "pagehide",
  (event) => {
    if (event.persisted) return;
    closeActiveApp();
    swipe.dispose();
    platform.dispose();
  },
  { once: true },
);
