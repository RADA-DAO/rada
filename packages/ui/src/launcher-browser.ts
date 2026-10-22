import { AppGrid, AppTile, type AppTileOptions } from "./launcher.ts";
import { Field } from "./field.ts";
import { Group, Text } from "./layout.ts";
import { Button } from "./button.ts";
export type LauncherItem = AppTileOptions & {
  id: string;
  group: string;
  favourite?: boolean;
  inFolder?: boolean;
};
export function filterLauncher(
  items: LauncherItem[],
  query: string,
  group: string,
) {
  const term = query.trim().normalize("NFKC").toLocaleLowerCase();
  return items.filter(
    (item) =>
      (!(group === "all" && !term) || !item.inFolder) &&
      (group === "all" ||
        (group === "favourites" ? item.favourite : item.group === group)) &&
      item.name.normalize("NFKC").toLocaleLowerCase().includes(term),
  );
}
/** Search updates only results, preserving typing focus and selection. */
export function LauncherBrowser(options: {
  items: LauncherItem[];
  state?: { query: string; group: string };
  label: string;
  searchLabel: string;
  emptyLabel: string;
  count(count: number): string;
  groups: { id: string; label: string }[];
  folders?: { id: string; name: string; apps: string[] }[];
  openFolder?(title: string, tiles: HTMLElement[]): void;
  arrange?(): void;
  arrangeLabel?: string;
}) {
  const state = options.state ?? { query: "", group: "all" };
  const results = Group();
  const status = Text("", { live: "polite" });
  status.classList.add("rada-visually-hidden");
  const folder = (name: string, icon: string, items: LauncherItem[]) => {
    const tile = AppTile({
      name,
      tier: "platform",
      onOpen() {
        tile.focus({ preventScroll: true });
        options.openFolder?.(name, items.map(AppTile));
      },
    });
    tile.dataset.folder = icon;
    const art = tile.querySelector(".rada-app-tile-art");
    if (art) art.innerHTML = folderIcons[icon] ?? folderIcons.apps ?? "";
    return tile;
  };
  const draw = () => {
    const items = filterLauncher(options.items, state.query, state.group);
    const folders = state.query
      ? []
      : [
          ...options.groups.map((group) =>
            folder(
              group.label,
              group.id,
              filterLauncher(options.items, "", group.id),
            ),
          ),
          ...(options.folders ?? []).map((f) =>
            folder(
              f.name,
              "apps",
              options.items.filter((item) => f.apps.includes(item.id)),
            ),
          ),
        ];
    results.replaceChildren(
      AppGrid({
        label: options.label,
        tiles: [...folders, ...items.map(AppTile)],
      }),
    );
    status.textContent = items.length
      ? options.count(items.length)
      : options.emptyLabel;
  };
  const search = Field({
    label: options.searchLabel,
    value: state.query,
    onInput(value) {
      state.query = value;
      draw();
    },
  });
  search.element.classList.add("rada-desktop-search");
  search.control.setAttribute("type", "search");
  search.control.setAttribute("placeholder", options.searchLabel);
  search.control.dataset.focusKey = "launcher-search";
  const root = Group([results, status, search.element]);
  root.classList.add("rada-launcher-browser");
  if (options.arrange) {
    const edit = Button(options.arrangeLabel ?? "", {
      onClick: () => {
        options.arrange?.();
      },
    });
    edit.classList.add("rada-desktop-edit");
    root.append(edit);
    const arrange = () => options.arrange?.();
    requestAnimationFrame(() => {
      void import("./launcher-gestures.ts")
        .then(({ installLauncherGestures }) => {
          if (root.isConnected) installLauncherGestures(root, arrange);
        })
        .catch(() => {
          // The focusable edit button still opens the editor if gestures fail.
        });
    });
  }
  draw();
  return root;
}

const folderIcons: Record<string, string> = {
  rada: '<path d="M32 15c-8-5-16-5-23-2v35c8-3 16-3 23 2 7-5 15-5 23-2V13c-7-3-15-3-23 2Z"/><path d="M32 15v35M17 23h9M17 32h9M38 23h9M38 32h9"/>',
  games:
    '<path d="M19 22h26c7 0 11 6 12 15l1 8c1 7-7 10-11 5l-7-8H24l-7 8c-4 5-12 2-11-5l1-8c1-9 5-15 12-15Z"/><path d="M20 31v10M15 36h10M44 33h.01M50 39h.01"/>',
  apps: '<rect x="11" y="11" width="16" height="16" rx="3"/><rect x="37" y="11" width="16" height="16" rx="3"/><rect x="11" y="37" width="16" height="16" rx="3"/><rect x="37" y="37" width="16" height="16" rx="3"/>',
  favourites:
    '<path d="M32 53S10 40 10 24c0-7 5-12 12-12 5 0 8 3 10 7 2-4 5-7 10-7 7 0 12 5 12 12 0 16-22 29-22 29Z"/>',
};
for (const key of Object.keys(folderIcons))
  folderIcons[key] =
    `<svg viewBox="0 0 64 64" aria-hidden="true">${folderIcons[key] ?? ""}</svg>`;
