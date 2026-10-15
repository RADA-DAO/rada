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

let locale: Locale = navigator.language.startsWith("uk") ? "uk" : "en";
let route: "launcher" | "profile" = "launcher";
let profile: "guest" | "loading" | "private" | "expired" | "unavailable" =
  "guest";
let sheet: HTMLDialogElement | undefined;
const root = document.querySelector<HTMLElement>("#app")!;
root.className = "screen-wrap";
const screen = document.createElement("main");
screen.className = "screen";
root.append(screen);
const text = (key: MessageKey) => t(locale, key);
const back = () => {
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
async function loadProfile() {
  profile = "loading";
  render();
  try {
    profile = (await platform.readOwnProfile()) ? "private" : "guest";
  } catch (error) {
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
        paragraph("shell.membershipUnavailable"),
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
        if (profile === "guest" && platform.authenticatedLaunch)
          void loadProfile();
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
    swipe.dispose();
    platform.dispose();
  },
  { once: true },
);
