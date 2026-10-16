import { element } from "./dom.ts";

/** Scrolling surface that holds the current screen. Created once per application. */
export function ScreenHost(root: HTMLElement): HTMLElement {
  root.className = "screen-wrap";
  const host = element("main", "screen");
  root.append(host);
  return host;
}

export type ScreenOptions = {
  title: string;
  /** Content above the title, such as the viewer's identity on the home screen. */
  top?: Node;
  /** Wordmark shown in the header. */
  brand?: string;
  /** Header controls, such as Settings. */
  actions?: Node[];
  children?: Node[];
  /** Bottom navigation, usually `Tabs`. */
  footer?: Node;
};

/**
 * One screen: header, title, content and optional footer navigation. Back is
 * never drawn here: the platform owns it (Telegram BackButton, browser Back,
 * Escape and the swipe), so screens cannot add a second one.
 */
export function Screen(options: ScreenOptions): HTMLElement {
  const view = element("div", "rada-screen-view");
  const header = element("header", "rada-screen-header");
  const lead = element("div", "rada-screen-lead");
  if (options.brand)
    lead.append(element("strong", "rada-screen-brand", options.brand));
  header.append(lead, ...(options.actions ?? []));
  const body = element("section", "rada-screen-body");
  if (options.top) body.append(options.top);
  body.append(
    element("h1", "rada-screen-title", options.title),
    ...(options.children ?? []),
  );
  view.append(header, body);
  if (options.footer) view.append(options.footer);
  return view;
}
