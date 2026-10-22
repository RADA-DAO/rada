import { element } from "./dom.ts";

/** Labelled values, such as participant counts and time left, as a description list. */
export function Facts(
  items: { label: string; value: string | Node }[],
): HTMLDListElement {
  const list = element("dl", "rada-facts");
  for (const item of items) {
    const row = element("div", "rada-facts-row");
    const value = element("dd", "rada-facts-value");
    value.append(item.value);
    row.append(element("dt", "rada-facts-label", item.label), value);
    list.append(row);
  }
  return list;
}

/** A short status mark next to content; `strong` draws attention to it. */
export function Badge(
  text: string,
  options: { tone?: "neutral" | "strong" } = {},
): HTMLElement {
  const badge = element(
    "span",
    options.tone === "strong" ? "rada-badge rada-badge--strong" : "rada-badge",
    text,
  );
  return badge;
}

/**
 * Time left until `until` (epoch milliseconds), redrawn every second. It is a
 * `timer`, so assistive technology does not announce each tick. `format`
 * receives the remaining milliseconds (never negative) and returns the text.
 * `onEnd` runs once when the time runs out while shown, not for a past time.
 */
export function Countdown(options: {
  until: number;
  format: (remaining: number) => string;
  /** Accessible name, such as "Time left in this round". */
  label: string;
  onEnd?: () => void;
  now?: () => number;
}): { element: HTMLElement; dispose(): void } {
  const now = options.now ?? Date.now;
  const timer = element("span", "rada-countdown");
  timer.setAttribute("role", "timer");
  timer.setAttribute("aria-label", options.label);
  let interval: ReturnType<typeof setInterval> | undefined;
  /** Redraws; returns false once time is up. */
  const draw = (): boolean => {
    const remaining = Math.max(0, options.until - now());
    timer.textContent = options.format(remaining);
    if (remaining > 0) return true;
    clearInterval(interval);
    // Only time that runs out while shown counts as an end, never a past one.
    if (interval !== undefined) options.onEnd?.();
    interval = undefined;
    return false;
  };
  if (draw())
    interval = setInterval(() => {
      draw();
    }, 1000);
  return {
    element: timer,
    dispose: () => {
      clearInterval(interval);
    },
  };
}
