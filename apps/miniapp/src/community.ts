import "@rada/ui/screens/community.css";
import { Group, Screen, Tabs } from "../../../packages/ui/src/index.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import { mountHolders } from "./holders.ts";

/** Community artwork frames the current public holder projection. */
export function showCommunity(
  host: HTMLElement,
  options: Parameters<typeof mountHolders>[1] & {
    active?: boolean;
    actions: Node[];
    sections?: Parameters<typeof Tabs>[0];
  },
) {
  const banner = Group();
  banner.classList.add("rada-community-banner");
  const content = Group();
  content.classList.add("rada-community-panel");
  const view = Screen({
    title: t(options.locale, "shell.community"),
    children: [banner, content],
  });
  view.classList.add("rada-community");
  const heading = view.querySelector<HTMLElement>("h1");
  if (!heading) throw new Error("Community heading unavailable");
  if (options.sections && options.sections.tabs.length > 1) {
    heading.classList.add("rada-visually-hidden");
    banner.append(Tabs(options.sections));
  } else {
    banner.append(heading);
  }
  host.replaceChildren(view);
  return options.active ? mountHolders(content, options) : () => {};
}
