import { element } from "./dom.ts";

export function Card(
  options: { children?: Node[]; label?: string } = {},
): HTMLElement {
  const card = element("section", "rada-card");
  if (options.label) card.setAttribute("aria-label", options.label);
  card.append(...(options.children ?? []));
  return card;
}

/** A titled group of content on a screen. */
export function Section(options: {
  title: string;
  children?: Node[];
}): HTMLElement {
  const section = element("section", "rada-section");
  section.append(
    element("h2", "rada-section-title", options.title),
    ...(options.children ?? []),
  );
  return section;
}

/** Body copy. Pass `live` for status text that assistive technology should announce. */
export function Text(
  content: string,
  options: { live?: "polite" | "assertive"; breakAnywhere?: boolean } = {},
): HTMLParagraphElement {
  const text = element("p", "rada-text", content);
  if (options.breakAnywhere) text.classList.add("rada-text--break");
  if (options.live) text.setAttribute("aria-live", options.live);
  return text;
}

/** Container whose changing content is announced politely. */
export function LiveRegion(children: Node[] = []): HTMLElement {
  const region = element("div", "rada-live-region");
  region.setAttribute("aria-live", "polite");
  region.append(...children);
  return region;
}

/** A row of related actions. */
export function Actions(children: Node[]): HTMLElement {
  const actions = element("div", "rada-actions");
  actions.append(...children);
  return actions;
}

/** Mount point for embedded app content; hidden while empty. */
export function Embed(): HTMLElement {
  return element("div", "rada-embed");
}

/** Plain grouping container for content that needs a mount point or data hook. */
export function Group(children: Node[] = []): HTMLElement {
  const group = element("div", "rada-group");
  group.append(...children);
  return group;
}
