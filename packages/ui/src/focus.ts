/** Keep keyboard position when asynchronous screens replace focused controls. */
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
    const changed = next !== heading;
    heading = next;
    if (document.querySelector("dialog[open]") && !host.matches("dialog[open]"))
      return;
    if (!changed && (!focused || focused.isConnected)) return;
    const key = focused?.dataset.focusKey;
    const replacement = key
      ? [...host.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
          (item) => item.dataset.focusKey === key && !item.matches(":disabled"),
        )
      : undefined;
    const target = changed ? next : (replacement ?? next);
    if (target) {
      if (target === next) target.tabIndex = -1;
      target.focus({ preventScroll: target !== next });
      if (target === next) host.scrollTop = 0;
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
      : (replacement ?? document.querySelector<HTMLElement>("main h1"));
  target?.focus();
}
