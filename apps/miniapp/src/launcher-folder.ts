import "@rada/ui/screens/folder.css";
import { AppGrid, openSheet, Text } from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type { Navigation } from "../../../packages/platform-sdk/src/index.ts";

export function openLauncherFolder(options: {
  title: string;
  tiles: HTMLElement[];
  locale: Locale;
  navigation: Navigation;
}) {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = openSheet({
    title: options.title,
    closeLabel: t(options.locale, "common.close"),
    navigation: options.navigation,
    opener,
    children: [
      AppGrid({ label: options.title, tiles: options.tiles }),
      ...(options.tiles.length
        ? []
        : [Text(t(options.locale, "launcher.empty"))]),
    ],
  });
  dialog.classList.add("rada-launcher-folder");
  for (const tile of options.tiles)
    tile.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Close the sheet stack entry before the app pushes its own destination.
        dialog.addEventListener(
          "close",
          () => {
            tile.click();
          },
          { once: true },
        );
        dialog.close();
      },
      { capture: true, once: true },
    );
}
