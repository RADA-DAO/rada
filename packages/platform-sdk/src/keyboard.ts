import "./keyboard.css";

export type KeyboardViewport = {
  canvasHeight: number;
  visibleHeight: number;
  width: number;
  reduced: boolean;
};
const textInputTypes = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
]);

export function nextKeyboardViewport(
  previous: KeyboardViewport,
  heights: number[],
  width: number,
  reset = false,
): KeyboardViewport {
  const valid = heights.filter(
    (height) => Number.isFinite(height) && height > 0,
  );
  const visibleHeight = valid.length
    ? Math.min(...valid)
    : previous.visibleHeight;
  const canvasHeight =
    reset || !previous.canvasHeight || Math.abs(width - previous.width) > 48
      ? visibleHeight
      : Math.max(previous.canvasHeight, visibleHeight);
  return {
    canvasHeight,
    visibleHeight,
    width,
    reduced: canvasHeight - visibleHeight > 120,
  };
}

export function isKeyboardInput(
  element: Element | null,
): element is HTMLInputElement | HTMLTextAreaElement {
  return Boolean(
    element &&
    (element.tagName === "TEXTAREA" ||
      (element.tagName === "INPUT" &&
        textInputTypes.has((element as HTMLInputElement).type))) &&
    !(element as HTMLInputElement).disabled &&
    !(element as HTMLInputElement).readOnly &&
    element.getAttribute("inputmode") !== "none",
  );
}

/** Only move as far as needed, including fields taller than the usable region. */
export function fieldScrollDelta(
  top: number,
  bottom: number,
  visibleTop: number,
  visibleBottom: number,
): number {
  if (visibleBottom <= visibleTop) return 0;
  if (top < visibleTop) return top - visibleTop;
  if (bottom > visibleBottom)
    return Math.min(bottom - visibleBottom, top - visibleTop);
  return 0;
}

type KeyboardOptions = {
  doneLabel: () => string;
  dismissLabel: () => string;
  hostHeight?: () => number | undefined;
  onViewport?: (viewport: KeyboardViewport) => void;
  onFocus?: (focused: boolean) => void;
};

/** Install once per document, including independently loaded native modules.
 * Delegation covers fields inserted after hydration without rebinding them. */
export function installAppKeyboard(options: KeyboardOptions) {
  const root = document.documentElement;
  let viewport: KeyboardViewport = {
    canvasHeight: 0,
    visibleHeight: 0,
    width: 0,
    reduced: false,
  };
  let frame = 0;
  let focused = false;
  let disposed = false;
  let done: HTMLButtonElement | null = null;
  let accessory: HTMLDivElement | null = null;
  const safeArea = document.createElement("span");
  safeArea.className = "rada-keyboard-safe-area";
  safeArea.setAttribute("aria-hidden", "true");
  document.body.append(safeArea);
  const activeField = () =>
    isKeyboardInput(document.activeElement) ? document.activeElement : null;
  const dismiss = () => activeField()?.blur();
  const observer = new MutationObserver(() => {
    if (!activeField()) schedule();
  });

  const syncDone = (field: HTMLInputElement | HTMLTextAreaElement | null) => {
    const numeric =
      field?.tagName === "INPUT" &&
      (field.type === "number" ||
        /^(numeric|decimal|tel)$/.test(field.inputMode));
    if (
      !field ||
      !viewport.reduced ||
      !numeric ||
      field.getAttribute("data-keyboard-accessory") === "none"
    ) {
      accessory?.remove();
      accessory = null;
      done = null;
      return;
    }
    if (!done) {
      accessory = document.createElement("div");
      accessory.className = "rada-keyboard-accessory";
      done = document.createElement("button");
      done.type = "button";
      done.className = "rada-keyboard-done";
      done.textContent = options.doneLabel();
      done.setAttribute("aria-label", options.dismissLabel());
      done.addEventListener("pointerdown", (event) => {
        event.preventDefault();
      });
      done.addEventListener("click", dismiss);
      accessory.append(done);
    }
    // A native dialog is in the top layer; a body button would be inert behind it.
    const host = field.closest("dialog[open]") ?? document.body;
    if (accessory && accessory.parentElement !== host) host.append(accessory);
  };

  const reveal = () => {
    frame = 0;
    if (disposed) return;
    const field = activeField();
    const nextFocused = Boolean(field);
    root.dataset.keyboardFocus = String(nextFocused);
    if (focused !== nextFocused) {
      focused = nextFocused;
      options.onFocus?.(focused);
      observer.disconnect();
      if (focused)
        observer.observe(document.body, { childList: true, subtree: true });
    }
    syncDone(field);
    if (!field) return;
    if (!field.hasAttribute("enterkeyhint"))
      field.setAttribute(
        "enterkeyhint",
        field.tagName === "TEXTAREA" ? "enter" : "done",
      );
    if (!viewport.reduced) return;

    // The shell already fits the visible viewport. Undo WebKit's document pan,
    // then reveal within actual scrolling ancestors, never scrollIntoView(body).
    if (window.scrollX || window.scrollY)
      window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    const safeTop = safeArea.getBoundingClientRect().top;
    const bottom = viewport.visibleHeight - (done ? 60 : 12);
    for (
      let parent = field.parentElement;
      parent && parent !== document.body;
      parent = parent.parentElement
    ) {
      const style = getComputedStyle(parent);
      if (
        !/(auto|scroll)/.test(style.overflowY) ||
        parent.scrollHeight <= parent.clientHeight + 1
      )
        continue;
      const bounds = parent.getBoundingClientRect();
      const rect = field.getBoundingClientRect();
      const topInset = Number.parseFloat(style.scrollPaddingTop) || 12;
      const bottomInset = Number.parseFloat(style.scrollPaddingBottom) || 12;
      const delta = fieldScrollDelta(
        rect.top,
        rect.bottom,
        Math.max(safeTop + 8, bounds.top + topInset),
        Math.min(bottom, bounds.bottom - bottomInset),
      );
      if (Math.abs(delta) > 1) parent.scrollTop += delta;
    }
  };
  function schedule() {
    if (!frame && !disposed) frame = window.requestAnimationFrame(reveal);
  }
  function refresh(reset = false) {
    viewport = nextKeyboardViewport(
      viewport,
      [
        options.hostHeight?.() ?? 0,
        window.visualViewport?.height ?? 0,
        window.innerHeight,
      ],
      window.visualViewport?.width ?? window.innerWidth,
      reset,
    );
    root.style.setProperty(
      "--app-height",
      `${String(viewport.canvasHeight)}px`,
    );
    root.style.setProperty(
      "--app-visible-height",
      `${String(viewport.visibleHeight)}px`,
    );
    root.style.setProperty(
      "--app-keyboard-inset",
      `${String(Math.max(0, window.innerHeight - viewport.visibleHeight))}px`,
    );
    root.dataset.appViewportReduced = String(viewport.reduced);
    options.onViewport?.(viewport);
    schedule();
  }
  const resized = () => {
    refresh();
  };
  const dismissControl = (event: MouseEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-keyboard-dismiss]")
    )
      dismiss();
  };
  const preserveFocus = (event: MouseEvent) => {
    const field = activeField();
    if (
      !field ||
      event.defaultPrevented ||
      event.button !== 0 ||
      !(event.target instanceof Element)
    )
      return;
    const target = event.target;
    // Companion controls update the active editor without dismissing/reopening
    // its keyboard. Tab navigation and explicit dismissal keep native behavior.
    if (
      !target.closest("[data-keyboard-preserve-focus]")?.contains(field) ||
      target.closest(
        "input,textarea,select,a,[contenteditable],[data-keyboard-dismiss]",
      )
    )
      return;
    event.preventDefault();
  };
  const keydown = (event: KeyboardEvent) => {
    const field = activeField();
    if (
      !field ||
      event.defaultPrevented ||
      event.isComposing ||
      Reflect.get(event, "keyCode") === 229 ||
      event.key !== "Enter"
    )
      return;
    if (field.tagName === "TEXTAREA") return; // Enter must preserve multiline editing.
    const hint = field.getAttribute("enterkeyhint") ?? "done";
    if (hint === "next") {
      const fields = [
        ...(field.form ?? document).querySelectorAll("input,textarea"),
      ]
        .filter(isKeyboardInput)
        .filter((input) => input.getClientRects().length);
      const next = fields[fields.indexOf(field) + 1];
      if (next) {
        event.preventDefault();
        next.focus({ preventScroll: true });
      }
    } else if (hint === "done") {
      event.preventDefault();
      dismiss();
    }
  };
  document.addEventListener("focusin", schedule);
  document.addEventListener("focusout", schedule);
  document.addEventListener("keydown", keydown);
  document.addEventListener("click", dismissControl);
  // iOS can still blur an editor after a cancelled pointerdown on a clickable
  // element (WebKit 322721). Leave pointerdown intact so the compatibility
  // mousedown is delivered, and cancel focus transfer there instead.
  document.addEventListener("mousedown", preserveFocus);
  window.addEventListener("resize", resized);
  window.addEventListener("scroll", schedule, { passive: true });
  window.visualViewport?.addEventListener("resize", resized);
  window.visualViewport?.addEventListener("scroll", schedule);
  refresh();
  return {
    refresh,
    dismiss,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      accessory?.remove();
      safeArea.remove();
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("click", dismissControl);
      document.removeEventListener("mousedown", preserveFocus);
      window.removeEventListener("resize", resized);
      window.removeEventListener("scroll", schedule);
      window.visualViewport?.removeEventListener("resize", resized);
      window.visualViewport?.removeEventListener("scroll", schedule);
    },
  };
}
