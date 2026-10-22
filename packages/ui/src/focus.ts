/** Restore shell focus on screen replacement; content manages its own focus. */
export function observeScreenFocus(
  host: HTMLElement,
  headingSelector = "h1",
): () => void {
  let focused: HTMLElement | null = null;
  let heading = host.querySelector<HTMLElement>(headingSelector);
  host.addEventListener("focusin", (event) => {
    if (event.target instanceof HTMLElement) focused = event.target;
  });
  const observer = new MutationObserver(() => {
    const next = host.querySelector<HTMLElement>(headingSelector);
    if (next === heading) {
      // Reparenting a live control can blur it without replacing the heading.
      if (
        focused?.isConnected &&
        document.activeElement === document.body &&
        !focused.closest("[inert]") &&
        !document.querySelector("dialog[open]")
      )
        focused.focus({ preventScroll: true });
      return;
    }
    const changed =
      !next?.dataset.focusKey ||
      next.dataset.focusKey !== heading?.dataset.focusKey;
    heading = next;
    if (document.querySelector("dialog[open]") && !host.matches("dialog[open]"))
      return;
    if (!changed && (!focused || focused.isConnected)) return;
    const key = focused?.dataset.focusKey;
    const replacement = key
      ? [...host.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
          (item) =>
            item.dataset.focusKey === key &&
            !item.matches(":disabled") &&
            !item.matches("[inert] *"),
        )
      : undefined;
    const target = changed ? next : (replacement ?? next);
    if (target) {
      if (target === next) target.tabIndex = -1;
      // Focus must never horizontally scroll the translated workspace rail.
      target.focus({ preventScroll: true });
      if (target === next) {
        const page = target.closest(".rada-workspace-page") ?? host;
        page.scrollTop = 0;
      }
    }
  });
  observer.observe(host, { childList: true, subtree: true });
  return () => {
    observer.disconnect();
  };
}

/** Resolve replaced openers; never send focus to a detached or disabled node. */
export function restoreSheetFocus(opener?: HTMLElement | null): void {
  const key = opener?.dataset.focusKey;
  const replacement = key
    ? [...document.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
        (item) => item.dataset.focusKey === key && !item.matches(":disabled"),
      )
    : undefined;
  const target =
    opener?.isConnected && !opener.matches(":disabled")
      ? opener
      : (replacement ??
        document.querySelector<HTMLElement>("main h1:not([inert] *)"));
  target?.focus({ preventScroll: true });
}
