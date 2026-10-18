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
}) {
  const state = options.state ?? { query: "", group: "all" };
  const results = Group();
  const status = Text("", { live: "polite" });
  const tabs = Group();
  const draw = () => {
    const items = filterLauncher(options.items, state.query, state.group);
    results.replaceChildren(
      AppGrid({ label: options.label, tiles: items.map(AppTile) }),
    );
    status.textContent = items.length
      ? options.count(items.length)
      : options.emptyLabel;
  };
  tabs.classList.add("rada-tabs");
  tabs.classList.add("rada-launcher-filters");
  tabs.setAttribute("role", "group");
  tabs.setAttribute("aria-label", options.label);
  for (const group of options.groups) {
    const button = Button(group.label, {
      variant: "ghost",
      onClick() {
        state.group = group.id;
        draw();
        for (const [index, item] of [
          ...tabs.querySelectorAll("button"),
        ].entries())
          item.setAttribute(
            "aria-pressed",
            String(options.groups[index]?.id === state.group),
          );
      },
    });
    button.setAttribute("aria-pressed", String(group.id === state.group));
    tabs.append(button);
  }
  const search = Field({
    label: options.searchLabel,
    value: state.query,
    onInput(value) {
      state.query = value;
      draw();
    },
  });
  search.control.setAttribute("type", "search");
  search.control.dataset.focusKey = "launcher-search";
  draw();
  return Group([search.element, tabs, status, results]);
}
