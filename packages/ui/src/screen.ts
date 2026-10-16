import { Button } from "./button.ts";
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
  /** Wordmark shown in the header. */
  brand?: string;
  /** Present when a previous screen exists; `onBack` should pop the platform navigation stack. */
  back?: { label: string; onBack: () => void };
  /** Header controls, such as Settings. */
  actions?: Node[];
  children?: Node[];
  /** Bottom navigation, usually `Tabs`. */
  footer?: Node;
};

/** One screen: header with Back, title, content and optional footer navigation. */
export function Screen(options: ScreenOptions): HTMLElement {
  const view = element("div", "rada-screen-view");
  const header = element("header", "rada-screen-header");
  const lead = element("div", "rada-screen-lead");
  const { back } = options;
  if (back)
    lead.append(Button(back.label, { variant: "ghost", onClick: back.onBack }));
  if (options.brand)
    lead.append(element("strong", "rada-screen-brand", options.brand));
  header.append(lead, ...(options.actions ?? []));
  const body = element("section", "rada-screen-body");
  body.append(
    element("h1", "rada-screen-title", options.title),
    ...(options.children ?? []),
  );
  view.append(header, body);
  if (options.footer) view.append(options.footer);
  return view;
}
