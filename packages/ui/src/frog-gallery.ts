import { element } from "./dom.ts";
import { Button } from "./button.ts";

/** Card-sized targets preserve native keyboard activation and visible focus. */
export function FrogGallery(options: {
  label: string;
  size?: "large" | "medium" | "compact";
  items: {
    card: HTMLElement;
    label: string;
    selected?: boolean;
    onOpen(): void;
  }[];
}): HTMLElement {
  const list = element("ul", "rada-frog-gallery");
  list.dataset.size = options.size ?? "large";
  list.setAttribute("aria-label", options.label);
  for (const item of options.items) {
    const row = element("li", "rada-frog-gallery-item");
    const button = Button("", {
      ariaLabel: item.label,
      variant: "ghost",
      onClick: () => {
        item.onOpen();
      },
    });
    button.classList.add("rada-frog-gallery-button");
    if (item.selected) button.setAttribute("aria-current", "true");
    button.append(item.card);
    row.append(button);
    list.append(row);
  }
  return list;
}
