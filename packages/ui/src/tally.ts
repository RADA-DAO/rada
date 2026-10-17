import { element } from "./dom.ts";

/** Labelled tally bars; counts remain readable without color or bar length. */
export function Tally(options: {
  label: string;
  items: { label: string; count: number }[];
}): HTMLElement {
  const root = element("div", "rada-tally");
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", options.label);
  const counts = options.items.map(({ count }) =>
    Number.isFinite(count) ? Math.max(0, count) : 0,
  );
  const total = counts.reduce((a, b) => a + b, 0);
  options.items.forEach((item, index) => {
    const count = counts[index] ?? 0;
    const row = element("div", "rada-tally-row");
    const bar = element("progress", "rada-tally-bar");
    bar.max = total || 1;
    bar.value = count;
    bar.setAttribute("aria-label", item.label);
    bar.setAttribute("aria-valuetext", String(count));
    row.append(
      element("span", "", item.label),
      element("span", "", String(count)),
      bar,
    );
    root.append(row);
  });
  return root;
}

/** External evidence links accept HTTPS only, without embedded credentials. */
export function EvidenceLink(options: {
  label: string;
  href: string;
}): HTMLElement {
  try {
    const url = new URL(options.href);
    if (url.protocol === "https:" && !url.username && !url.password) {
      const link = element("a", "rada-evidence-link", options.label);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      return link;
    }
  } catch {
    /* Invalid evidence remains plain text. */
  }
  return element("span", "rada-evidence-text", options.label);
}
