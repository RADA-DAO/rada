import { Button } from "./button.ts";
import { element } from "./dom.ts";

export type Tab = { id: string; label: string; onSelect: () => void };

/** Primary navigation between top-level screens. */
export function Tabs(options: {
  label: string;
  tabs: Tab[];
  selected: string;
}): HTMLElement {
  const nav = element("nav", "rada-tabs");
  nav.setAttribute("aria-label", options.label);
  for (const tab of options.tabs) {
    const button = Button(tab.label, {
      variant: "ghost",
      onClick: tab.onSelect,
    });
    button.setAttribute(
      "aria-current",
      tab.id === options.selected ? "page" : "false",
    );
    nav.append(button);
  }
  return nav;
}
