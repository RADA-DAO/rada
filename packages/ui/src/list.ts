import { element } from "./dom.ts";

export function List(options: {
  label?: string;
  children?: Node[];
  /** Show bullets, for short lists of plain values. */
  marked?: boolean;
}): HTMLUListElement {
  const list = element(
    "ul",
    options.marked ? "rada-list rada-list--marked" : "rada-list",
  );
  if (options.label) list.setAttribute("aria-label", options.label);
  list.append(...(options.children ?? []));
  return list;
}

export function ListItem(options: {
  title?: string;
  /** Show the title as a level 2 heading instead of emphasized text. */
  heading?: boolean;
  /** Full text for a shortened title, exposed on hover. */
  titleHint?: string;
  description?: string;
  leading?: Node;
  /** Extra content under the text, such as a form. */
  children?: Node[];
  actions?: Node[];
}): HTMLLIElement {
  const item = element("li", "rada-list-item");
  if (options.leading) item.append(options.leading);
  const main = element("div", "rada-list-item-main");
  if (options.title) {
    const title = element(
      options.heading ? "h2" : "p",
      "rada-list-item-title",
      options.title,
    );
    if (options.titleHint) title.title = options.titleHint;
    main.append(title);
  }
  if (options.description)
    main.append(element("p", "rada-list-item-text", options.description));
  main.append(...(options.children ?? []));
  if (options.actions?.length) {
    const actions = element("div", "rada-actions");
    actions.append(...options.actions);
    main.append(actions);
  }
  item.append(main);
  return item;
}
