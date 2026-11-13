export type HostInsets = {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
};
export type ViewportHost = {
  safeAreaInset?: HostInsets;
  contentSafeAreaInset?: HostInsets;
  isFullscreen?: boolean;
};

/** Telegram reports overlapping coordinate spaces, not additive padding. */
export function hostInsets(host?: ViewportHost) {
  const bounded = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.min(320, Math.max(0, value))
      : 0;
  return Object.fromEntries(
    (["top", "right", "bottom", "left"] as const).map((side) => [
      side,
      {
        safe: bounded(host?.safeAreaInset?.[side]),
        content: bounded(host?.contentSafeAreaInset?.[side]),
      },
    ]),
  ) as Record<keyof HostInsets, { safe: number; content: number }>;
}

/** Preserve browser safe areas while projecting the current host geometry. */
export function syncHostViewport(root: HTMLElement, host?: ViewportHost) {
  const insets = hostInsets(host);
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const { safe, content } = insets[side];
    root.style.setProperty(
      `--app-safe-${side}`,
      `max(env(safe-area-inset-${side}, 0px), ${String(safe)}px)`,
    );
    root.style.setProperty(
      `--app-content-safe-${side}`,
      `max(var(--app-safe-${side}), ${String(content)}px)`,
    );
  }
  root.dataset.telegramFullscreen = String(host?.isFullscreen === true);
  root.style.setProperty(
    "--app-workspace-safe-top",
    `calc(var(--app-content-safe-top) + ${host?.isFullscreen ? "40" : "0"}px)`,
  );
}
