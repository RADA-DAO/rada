import {
  Countdown,
  Group,
  Tabs,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { SplashContext } from "./context.ts";
import { loadInto } from "./context.ts";
import { clock } from "./format.ts";
import { mountPond } from "./pond.ts";
import { mountQueue } from "./queue.ts";
import { mountResults } from "./results.ts";

type ArenaTab = "live" | "next" | "history";
const selection = new WeakMap<SplashContext["client"], ArenaTab>();

/** Live arena, next-round submissions and the round chronicle share one frame. */
export function mountArena(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const banner = Group();
  banner.classList.add("splash-banner");
  const content = Group();
  const navigation = Group();
  content.id = "splash-arena-panel";
  content.tabIndex = 0;
  content.setAttribute("role", "tabpanel");
  let stop = () => {};
  let timer: ReturnType<typeof Countdown> | undefined;
  let current: AbortController | undefined;
  const screens = { live: mountPond, next: mountQueue, history: mountResults };
  const select = (selected: keyof typeof screens) => {
    selection.set(context.client, selected);
    const hadFocus = navigation.contains(document.activeElement);
    current?.abort();
    stop();
    current = new AbortController();
    content.replaceChildren();
    content.className = "rada-group splash-panel-content";
    navigation.replaceChildren(
      Tabs({
        label: context.text("splash.navigation"),
        selected,
        tabs: [
          {
            id: "live",
            label: context.text("splash.liveTab"),
            onSelect: () => {
              select("live");
            },
          },
          {
            id: "next",
            label: context.text("splash.nextTab"),
            onSelect: () => {
              select("next");
            },
          },
          {
            id: "history",
            label: context.text("splash.resultsTitle"),
            onSelect: () => {
              select("history");
            },
          },
        ],
      }),
    );
    const tabs = navigation.querySelector("nav");
    if (!tabs) return;
    tabs.classList.add("splash-tabs");
    tabs.setAttribute("role", "tablist");
    const buttons = [...tabs.querySelectorAll("button")];
    const ids: ArenaTab[] = ["live", "next", "history"];
    buttons.forEach((button, index) => {
      const id = ids[index];
      if (!id) return;
      const active = id === selected;
      button.id = `splash-tab-${id}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active));
      button.setAttribute("aria-controls", content.id);
      button.removeAttribute("aria-current");
      button.tabIndex = active ? 0 : -1;
      button.addEventListener("keydown", (event) => {
        const target =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : event.key === "ArrowRight"
                ? (index + 1) % buttons.length
                : event.key === "ArrowLeft"
                  ? (index + buttons.length - 1) % buttons.length
                  : undefined;
        if (target === undefined) return;
        event.preventDefault();
        const next = ids[target];
        if (next) select(next);
      });
    });
    content.setAttribute("aria-labelledby", `splash-tab-${selected}`);
    if (hadFocus)
      navigation.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    stop = screens[selected](content, {
      ...context,
      signal: AbortSignal.any([context.signal, current.signal]),
    });
  };
  container.append(banner, navigation, content);
  const loadBanner = async (): Promise<Node[]> => {
    timer?.dispose();
    const round = await context.client.round(context.signal);
    if (context.signal.aborted || !round) return [];
    const live = Text(
      context.text(
        round.acceptingBids ? "splash.liveStatus" : "splash.roundClosing",
      ),
    );
    live.classList.add("splash-banner-live");
    const countdown = Group([Text(context.text("splash.finishLabel"))]);
    countdown.classList.add("splash-banner-clock");
    timer = Countdown({
      until: round.endsAt,
      label: context.text("splash.timeLeftLabel"),
      format: clock,
      onEnd: () => {
        void loadInto(context, banner, loadBanner);
        select("live");
      },
    });
    countdown.append(timer.element);
    return [live, countdown];
  };
  void loadInto(context, banner, loadBanner);
  select(selection.get(context.client) ?? "live");
  return () => {
    current?.abort();
    stop();
    timer?.dispose();
  };
}
