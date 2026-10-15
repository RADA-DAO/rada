import {
  resolveSwipeAxis,
  shouldCommitSwipe,
  swipeSettleDurationMs,
} from "./screen-swipe-physics.ts";
import "./swipe-back.css";

export type SwipeBackPreview = { element: HTMLElement; restoreScroll(): void };
export type SwipeBackPreviewFactory = () => SwipeBackPreview | null;

/** A visual snapshot only: never mount controllers or navigate to prepare a back gesture. */
export function captureSwipeBackPage(
  source: HTMLElement,
): SwipeBackPreviewFactory {
  const template = source.cloneNode(true) as HTMLElement;
  // Most descendants are not scrollers. Writing zero to every cloned node on
  // the first drag frame repeatedly invalidates layout in long legacy lists.
  const scroll = [source, ...source.querySelectorAll<HTMLElement>("*")]
    .map((node, index) => ({
      index,
      top: node.scrollTop,
      left: node.scrollLeft,
    }))
    .filter(({ top, left }) => top !== 0 || left !== 0);
  for (const node of [template, ...template.querySelectorAll("*")]) {
    // Inert blocks interaction, but an iframe or media source can still load.
    // A visual return preview must never start another embedded application.
    if (/^(IFRAME|VIDEO|AUDIO|SOURCE)$/.test(node.tagName)) {
      node.removeAttribute("src");
      node.removeAttribute("srcdoc");
      node.removeAttribute("autoplay");
    }
    for (const attribute of [...node.attributes]) {
      // Prevent duplicate ids and shell/controller discovery in the inert preview.
      if (attribute.name === "id" || attribute.name.startsWith("data-"))
        node.removeAttribute(attribute.name);
    }
  }
  return () => {
    const element = template.cloneNode(true) as HTMLElement;
    return {
      element,
      restoreScroll() {
        if (!scroll.length) return;
        const nodes = [element, ...element.querySelectorAll<HTMLElement>("*")];
        for (const { index, top, left } of scroll) {
          const node = nodes[index];
          if (!node) continue;
          node.scrollTop = top;
          node.scrollLeft = left;
        }
      },
    };
  };
}

/** Text editing and surfaces with their own continuous gesture always win. */
export function ownsSwipeBackGesture(
  target: Element,
  screen: HTMLElement,
): boolean {
  if (
    target.closest(
      'input, textarea, select, label, [contenteditable]:not([contenteditable="false"]), [role="slider"], [role="spinbutton"], [draggable="true"], video, audio, canvas, iframe, dialog, [role="dialog"], [data-swipe-back-ignore], [data-screen-swipe-ignore], [data-draggable-sticker]',
    )
  )
    return true;
  for (
    let node: Element | null = target;
    node && node !== screen;
    node = node.parentElement
  ) {
    if (
      node.scrollWidth > node.clientWidth + 1 &&
      /^(auto|scroll)$/.test(getComputedStyle(node).overflowX)
    )
      return true;
  }
  return false;
}

/** Opt-in page gesture. The module owns back history; this controller owns only interaction. */
export function installSwipeBack(
  screen: HTMLElement,
  options: {
    canStart(): boolean;
    back(): void;
    preview?: SwipeBackPreviewFactory;
    onActiveChange?(active: boolean): void;
  },
) {
  const doc = screen.ownerDocument;
  // Transform the viewport, not its scroller. A transform on .screen changes
  // the containing block of fixed docks and jumps them by screen.scrollTop.
  const motion = screen.parentElement?.classList.contains("screen-wrap")
    ? screen.parentElement
    : screen;
  let gesture: {
    id: number;
    x: number;
    y: number;
    dx: number;
    dy: number;
    width: number;
    locked: boolean;
    samples: { x: number; at: number }[];
  } | null = null;
  let preview: HTMLElement | null = null;
  let settling = false,
    disposed = false,
    suppressClickUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let finishTransition: ((event: TransitionEvent) => void) | null = null;
  const active = () => Boolean(gesture || settling);
  const release = () => {
    const id = gesture?.id;
    if (id !== undefined && screen.hasPointerCapture(id))
      screen.releasePointerCapture(id);
  };
  function reset() {
    const wasActive = active();
    const id = gesture?.id;
    gesture = null;
    settling = false;
    if (id !== undefined && screen.hasPointerCapture(id))
      screen.releasePointerCapture(id);
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    frame = 0;
    if (finishTransition)
      motion.removeEventListener("transitionend", finishTransition);
    finishTransition = null;
    preview?.remove();
    preview = null;
    motion.classList.remove("rada-back-dragging", "rada-back-settling");
    motion.style.removeProperty("--back-x");
    motion.style.removeProperty("--back-duration");
    if (wasActive) options.onActiveChange?.(false);
  }
  function paint(dx: number, width: number) {
    motion.style.setProperty("--back-x", `${String(dx)}px`);
    // Clip the preview to the revealed strip: translucent frog surfaces never overlap.
    preview?.style.setProperty(
      "clip-path",
      `inset(0 ${String(Math.max(0, width - dx))}px 0 0)`,
    );
    preview?.style.setProperty(
      "--back-preview-x",
      `${String((dx - width) * 0.22)}px`,
    );
  }
  function settle(commit: boolean, velocity = 0) {
    const g = gesture;
    if (!g || settling) return;
    if (!g.locked) {
      reset();
      return;
    }
    settling = true;
    release();
    suppressClickUntil = performance.now() + 500;
    const duration = swipeSettleDurationMs({
      remainingDistance: commit ? g.width - g.dx : g.dx,
      width: g.width,
      velocityX: velocity,
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
    });
    motion.style.setProperty("--back-duration", `${String(duration)}ms`);
    preview?.style.setProperty("--back-duration", `${String(duration)}ms`);
    motion.classList.remove("rada-back-dragging");
    motion.classList.add("rada-back-settling");
    preview?.classList.add("rada-back-settling");
    const finish = () => {
      if (disposed || !settling) return;
      reset();
      if (commit) options.back();
    };
    finishTransition = (event) => {
      if (event.target === motion && event.propertyName === "translate")
        finish();
    };
    motion.addEventListener("transitionend", finishTransition);
    // Commit only after the outgoing page finishes, including reduced-motion and missing transitionend.
    frame = requestAnimationFrame(() => {
      paint(commit ? g.width : 0, g.width);
      if (!duration) finish();
    });
    timer = setTimeout(finish, duration + 100);
  }
  function down(event: PointerEvent) {
    if (!event.isPrimary) {
      settle(false);
      return;
    }
    if (!active()) suppressClickUntil = 0;
    if (disposed || active() || event.button !== 0 || !options.canStart())
      return;
    const target = event.target;
    if (
      !(target instanceof Element) ||
      ownsSwipeBackGesture(target, screen) ||
      doc.getSelection()?.type === "Range"
    )
      return;
    const width = screen.getBoundingClientRect().width;
    if (width <= 0) return;
    gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      dx: 0,
      dy: 0,
      width,
      locked: false,
      samples: [{ x: event.clientX, at: event.timeStamp }],
    };
    options.onActiveChange?.(true);
  }
  function move(event: PointerEvent) {
    const g = gesture;
    if (!g || settling || event.pointerId !== g.id) return;
    const dx = event.clientX - g.x,
      dy = event.clientY - g.y;
    if (!g.locked) {
      const axis = resolveSwipeAxis(dx, dy, "pending");
      if (axis === "vertical" || dx < -9) {
        reset();
        return;
      }
      if (axis !== "horizontal" || dx <= 0) return;
      if (!options.canStart() || doc.getSelection()?.type === "Range") {
        reset();
        return;
      }
      g.locked = true;
      screen.setPointerCapture(event.pointerId);
      const page = options.preview?.();
      if (page && motion.parentElement) {
        preview = doc.createElement("div");
        preview.className = "rada-back-preview";
        preview.setAttribute("aria-hidden", "true");
        preview.setAttribute("inert", "");
        const viewport = doc.createElement("div");
        viewport.className = "rada-back-preview-page";
        viewport.append(page.element);
        preview.append(viewport);
        motion.parentElement.append(preview);
        page.restoreScroll();
      }
      motion.classList.add("rada-back-dragging");
    }
    event.preventDefault();
    g.dx = Math.max(0, Math.min(dx, g.width));
    g.dy = dy;
    g.samples = [
      ...g.samples.filter((sample) => event.timeStamp - sample.at <= 100),
      { x: event.clientX, at: event.timeStamp },
    ];
    paint(g.dx, g.width);
  }
  function up(event: PointerEvent) {
    const g = gesture;
    if (!g || settling || event.pointerId !== g.id) return;
    if (g.locked) {
      g.dx = Math.max(0, Math.min(event.clientX - g.x, g.width));
      g.dy = event.clientY - g.y;
    }
    const sample = g.samples.find(
      (sample) => event.timeStamp - sample.at <= 100,
    );
    const velocity =
      sample && event.timeStamp > sample.at
        ? (event.clientX - sample.x) / (event.timeStamp - sample.at)
        : 0;
    settle(
      g.dx > 0 &&
        options.canStart() &&
        shouldCommitSwipe({
          dx: g.dx,
          dy: g.dy,
          width: g.width,
          velocityX: velocity,
          axis: g.locked ? "horizontal" : "pending",
          hasTarget: true,
        }),
      velocity,
    );
  }
  function cancel() {
    if (!settling) settle(false);
  }
  function lostCapture(event: PointerEvent) {
    // Touch implicitly captures the hit child first. Moving capture to the
    // screen emits a bubbling loss from that child; it is not a lost gesture.
    if (event.target === screen && event.pointerId === gesture?.id) cancel();
  }
  function additionalPointer(event: PointerEvent) {
    if (gesture && event.pointerId !== gesture.id) cancel();
  }
  function click(event: MouseEvent) {
    if (performance.now() < suppressClickUntil && event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }
  function interrupt() {
    if (active()) reset();
  }
  screen.addEventListener("pointerdown", down);
  screen.addEventListener("pointermove", move, { passive: false });
  screen.addEventListener("lostpointercapture", lostCapture);
  doc.addEventListener("pointerup", up);
  doc.addEventListener("pointercancel", cancel);
  doc.addEventListener("pointerdown", additionalPointer);
  doc.addEventListener("click", click, true);
  window.addEventListener("blur", interrupt);
  window.addEventListener("resize", interrupt);
  doc.addEventListener("visibilitychange", interrupt);
  return {
    active,
    cancel: interrupt,
    dispose() {
      disposed = true;
      reset();
      screen.removeEventListener("pointerdown", down);
      screen.removeEventListener("pointermove", move);
      screen.removeEventListener("lostpointercapture", lostCapture);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", cancel);
      doc.removeEventListener("click", click, true);
      doc.removeEventListener("pointerdown", additionalPointer);
      window.removeEventListener("blur", interrupt);
      window.removeEventListener("resize", interrupt);
      doc.removeEventListener("visibilitychange", interrupt);
    },
  };
}
