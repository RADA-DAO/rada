import "@rada/ui/screens/folder.css";
import { AppGrid, Button, Text } from "../../../packages/ui/src/index.ts";
import { LauncherFolder } from "../../../packages/ui/src/launcher.ts";
import { restoreSheetFocus } from "../../../packages/ui/src/focus.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type { Navigation } from "../../../packages/platform-sdk/src/index.ts";

/** Folder contents share the workspace wordmark, material and page navigation. */
export function openLauncherFolder(options: {
  title: string;
  tiles: HTMLElement[];
  locale: Locale;
  navigation: Navigation;
}) {
  const opener = document.activeElement as HTMLElement | null;
  const body = opener?.closest<HTMLElement>(".rada-screen-body");
  if (!body) return;
  const previous = [...body.childNodes];
  const back = Button(t(options.locale, "launcher.back"), {
    variant: "ghost",
    onClick: () => void options.navigation.back(),
  });
  back.classList.add("rada-folder-back");
  const folder = LauncherFolder({
    title: options.title,
    children: [
      back,
      AppGrid({ label: options.title, tiles: options.tiles }),
      ...(options.tiles.length
        ? []
        : [Text(t(options.locale, "launcher.empty"))]),
    ],
  });
  const heading = folder.querySelector("h1");
  if (heading) heading.tabIndex = -1;
  body.replaceChildren(folder);
  const key = "launcher-folder";
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    observer.disconnect();
    document.removeEventListener("click", selectPage, true);
    if (folder.isConnected) body.replaceChildren(...previous);
    queueMicrotask(() => {
      if (options.navigation.top.key === "launcher") restoreSheetFocus(opener);
    });
  };
  const selectPage = (event: MouseEvent) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(".rada-page-dots button")
    )
      return;
    close();
    options.navigation.drop(key);
  };
  document.addEventListener("click", selectPage, true);
  // Passive workspace refreshes may replace the launcher while this entry is open.
  const observer = new MutationObserver(() => {
    if (!folder.isConnected) {
      close();
      if (options.navigation.top.key === key) options.navigation.drop(key);
    }
  });
  observer.observe(body.closest(".screen") ?? body, {
    childList: true,
    subtree: true,
  });
  options.navigation.push({
    key,
    edgeBack: true,
    leave: close,
    stale: () => closed,
  });
  heading?.focus({ preventScroll: true });
  for (const tile of options.tiles)
    tile.addEventListener(
      "click",
      () => {
        close();
        options.navigation.drop(key);
      },
      { capture: true, once: true },
    );
}
