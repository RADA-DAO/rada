import { RADA_THEME_TOKEN_NAMES } from "../../ui/src/index.ts";
import { RADA_DESIGN_TOKEN_NAMES } from "../../ui/src/design-tokens.ts";

/** Only public rendering roles cross the frame boundary, never profile documents. */
export const APP_UI_TOKEN_NAMES = [
  ...RADA_THEME_TOKEN_NAMES,
  ...RADA_DESIGN_TOKEN_NAMES.filter(
    (name) => !/icon|frog|picture|avatar/.test(name),
  ),
] as const;
const names = new Set<string>(APP_UI_TOKEN_NAMES);
export type AppUiContext = {
  version: 1;
  rootFontSize: number;
  tokens: Record<string, string>;
  viewport: {
    width: number;
    height: number;
    visibleHeight: number;
    keyboardInset: number;
  };
  safeArea: { top: number; right: number; bottom: number; left: number };
  reducedMotion: boolean;
};
export type AppContext = { locale: "en" | "uk"; ui: AppUiContext };

export function sanitizeUiTokens(
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) =>
        names.has(name) &&
        value.length > 0 &&
        value.length <= 512 &&
        !/[;{}<>\\]|url\s*\(|expression\s*\(|@|javascript:/i.test(value),
    ),
  );
}
const dimension = (value: number) =>
  Math.round(Math.min(16384, Math.max(0, Number.isFinite(value) ? value : 0)));

export function appRootFontSize(value: string): number {
  const size = Number.parseFloat(value);
  return Number.isFinite(size) ? Math.min(32, Math.max(12, size)) : 16;
}

function readAppUiContext(
  container: HTMLElement,
  probe: HTMLElement,
): AppUiContext {
  const style = getComputedStyle(document.documentElement);
  const rect = container.getBoundingClientRect();
  const visible = Math.min(
    window.innerHeight,
    window.visualViewport?.height ?? window.innerHeight,
  );
  const insets = getComputedStyle(probe);
  const inset = (side: string) =>
    Math.min(
      512,
      Math.max(
        0,
        Number.parseFloat(insets.getPropertyValue(`padding-${side}`)) || 0,
      ),
    );
  const height = dimension(rect.height);
  const visibleHeight = dimension(
    Math.min(rect.bottom, visible) - Math.max(0, rect.top),
  );
  return {
    version: 1,
    rootFontSize: appRootFontSize(style.fontSize),
    tokens: sanitizeUiTokens(
      Object.fromEntries(
        APP_UI_TOKEN_NAMES.map((name) => [
          name,
          style.getPropertyValue(name).trim(),
        ]),
      ),
    ),
    viewport: {
      width: dimension(rect.width),
      height,
      visibleHeight,
      keyboardInset: Math.max(0, height - visibleHeight),
    },
    // Only the part not already consumed by shell layout belongs to the child.
    safeArea: {
      top: dimension(Math.max(0, inset("top") - rect.top)),
      left: dimension(Math.max(0, inset("left") - rect.left)),
      right: dimension(
        Math.max(0, rect.right - (window.innerWidth - inset("right"))),
      ),
      bottom: dimension(Math.max(0, rect.bottom - (visible - inset("bottom")))),
    },
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}

/** Resolve inherited max()/calc()/env() insets once through a reusable layout probe. */
export function createAppUiContextReader(container: HTMLElement) {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.dataset.radaUiProbe = "true";
  Object.assign(probe.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    width: "0",
    height: "0",
  });
  for (const side of ["top", "right", "bottom", "left"])
    probe.style.setProperty(
      `padding-${side}`,
      `var(--app-content-safe-${side}, var(--app-safe-${side}, 0px))`,
    );
  document.body.append(probe);
  return {
    read: () => readAppUiContext(container, probe),
    dispose: () => {
      probe.remove();
    },
  };
}

/** Coalesced snapshots do not remount the child or mutate its focused controls. */
export function observeAppUiContext(
  container: HTMLElement,
  publish: () => void,
): () => void {
  let frame = 0;
  const schedule = () => {
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        publish();
      });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [
      "style",
      "class",
      "data-theme",
      "data-rada-text-size",
      "dir",
      "lang",
    ],
  });
  const resize = new ResizeObserver(schedule);
  resize.observe(container);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  motion.addEventListener("change", schedule);
  window.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  window.visualViewport?.addEventListener("scroll", schedule);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    motion.removeEventListener("change", schedule);
    window.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("resize", schedule);
    window.visualViewport?.removeEventListener("scroll", schedule);
  };
}

/** Suppress identical passive snapshots without keeping identity or application state. */
export function contextPublisher(
  read: () => AppContext,
  publish: (value: AppContext) => void,
) {
  let last = "";
  return () => {
    const value = read();
    const serialized = JSON.stringify(value);
    if (serialized !== last) {
      last = serialized;
      publish(value);
    }
  };
}
