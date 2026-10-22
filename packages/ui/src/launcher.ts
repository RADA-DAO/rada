import { Avatar } from "./avatar.ts";
import { element, uniqueId } from "./dom.ts";

/** Who stands behind an app. Platform entries are RADA itself and carry no mark. */
export type AppTier = "platform" | "official" | "community";

export type AppTileOptions = {
  name: string;
  tier: AppTier;
  /** Visible, translated tier mark; required for official and community apps. */
  tierLabel?: string;
  /** A loadable square picture for the app; the monogram shows without it or if it fails. */
  iconUrl?: string;
  onOpen: () => void;
  disabled?: boolean;
};

const monogram = (name: string): string =>
  Array.from(new Intl.Segmenter().segment(name.trim()), (part) => part.segment)
    .slice(0, 1)
    .join("")
    .toUpperCase();

/**
 * One launcher icon: art, name and tier mark. The whole tile is the button, so
 * its accessible name is the app name and the tier is read as its description.
 */
export function AppTile(options: AppTileOptions): HTMLButtonElement {
  const tile = element("button", "rada-app-tile");
  tile.type = "button";
  tile.dataset.focusKey = `app:${options.name}`;
  tile.dataset.tier = options.tier;
  tile.disabled = options.disabled ?? false;
  const art = element("span", "rada-app-tile-art");
  art.setAttribute("aria-hidden", "true");
  if (options.iconUrl) {
    const icon = element("img", "rada-app-tile-icon");
    icon.alt = "";
    icon.src = options.iconUrl;
    icon.addEventListener("error", () => {
      icon.remove();
      art.textContent = monogram(options.name);
    });
    art.append(icon);
  } else art.textContent = monogram(options.name);
  const name = element("span", "rada-app-tile-name", options.name);
  name.id = uniqueId("rada-app-tile");
  tile.setAttribute("aria-labelledby", name.id);
  tile.append(art, name);
  if (options.tier !== "platform" && options.tierLabel) {
    const mark = element("span", "rada-app-tile-tier", options.tierLabel);
    mark.id = uniqueId("rada-app-tier");
    tile.setAttribute("aria-describedby", mark.id);
    tile.append(mark);
  }
  tile.addEventListener("click", options.onOpen);
  return tile;
}

/** A labelled four-column grid of tiles, in reading and focus order. */
export function AppGrid(options: {
  label: string;
  tiles: HTMLElement[];
}): HTMLUListElement {
  const grid = element("ul", "rada-app-grid");
  grid.setAttribute("aria-label", options.label);
  for (const tile of options.tiles) {
    const item = element("li", "rada-app-grid-item");
    item.append(tile);
    grid.append(item);
  }
  // Safari may skip buttons in native Tab order unless full keyboard access is on.
  grid.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey)
      return;
    const tiles = options.tiles.filter((tile) => !tile.matches(":disabled"));
    const index = tiles.indexOf(document.activeElement as HTMLElement);
    const next =
      index < 0 ? undefined : tiles[index + (event.shiftKey ? -1 : 1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  });
  return grid;
}

/** The viewer's identity: frog avatar, name and a short status line. */
export function Identity(options: {
  name: string;
  caption?: string;
  imageUrl?: string;
}): HTMLElement {
  const identity = element("div", "rada-identity");
  const text = element("div", "rada-identity-text");
  text.append(element("p", "rada-identity-name", options.name));
  if (options.caption)
    text.append(element("p", "rada-identity-caption", options.caption));
  identity.append(
    Avatar({
      name: options.name,
      ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
    }),
    text,
  );
  return identity;
}

/** A folder replaces desktop content while retaining the workspace frame. */
export function LauncherFolder(options: { title: string; children: Node[] }) {
  const folder = element("section", "rada-launcher-folder");
  const heading = element("h1", "rada-folder-title", options.title);
  heading.tabIndex = -1;
  heading.dataset.focusKey = `folder:${options.title}`;
  folder.append(heading, ...options.children);
  return folder;
}
