/** Finger-following workspace with axis locking, edge resistance and velocity settling. */
export function workspaceSwipe(
  host: HTMLElement,
  options: {
    physics: Pick<
      typeof import("../../platform-sdk/src/screen-swipe-physics.ts"),
      | "resolveSwipeAxis"
      | "rubberBandSwipeOffset"
      | "shouldCommitSwipe"
      | "swipeSettleDurationMs"
    >;
    enabled(): boolean;
    index(): number;
    select(index: number): void;
    track(): HTMLElement;
    settled(): void;
  },
) {
  let gesture:
    | {
        x: number;
        y: number;
        id: number;
        lastX: number;
        lastAt: number;
        velocity: number;
        axis: "pending" | "horizontal" | "vertical";
      }
    | undefined;
  let settling = false,
    offset = 0,
    suppress = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const clear = () => {
    clearTimeout(timer);
    const track = options.track();
    track.style.removeProperty("--workspace-drag");
    track.style.removeProperty("--workspace-duration");
    track.removeAttribute("data-settling");
    settling = false;
    gesture = undefined;
    offset = 0;
  };
  const down = (event: PointerEvent) => {
    if (
      settling ||
      gesture ||
      !options.enabled() ||
      event.button !== 0 ||
      !event.isPrimary ||
      (event.target as Element).closest(
        'input, textarea, select, dialog, iframe, [draggable="true"]',
      )
    )
      return;
    for (
      let node = event.target as HTMLElement | null;
      node && node !== host;
      node = node.parentElement
    ) {
      if (
        node.scrollWidth > node.clientWidth &&
        /auto|scroll/.test(getComputedStyle(node).overflowX)
      )
        return;
    }
    gesture = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      lastX: event.clientX,
      lastAt: event.timeStamp,
      velocity: 0,
      axis: "pending",
    };
  };
  const move = (event: PointerEvent) => {
    const g = gesture;
    if (!g || g.id !== event.pointerId) return;
    const dx = event.clientX - g.x,
      dy = event.clientY - g.y;
    const previous = g.axis;
    g.axis = options.physics.resolveSwipeAxis(dx, dy, g.axis);
    if (previous !== "horizontal" && g.axis === "horizontal")
      host.setPointerCapture(event.pointerId);
    if (g.axis !== "horizontal") return;
    event.preventDefault();
    if (event.timeStamp > g.lastAt)
      g.velocity = (event.clientX - g.lastX) / (event.timeStamp - g.lastAt);
    g.lastX = event.clientX;
    g.lastAt = event.timeStamp;
    const next = options.index() + (dx < 0 ? 1 : -1),
      width = host.clientWidth;
    offset = options.physics.rubberBandSwipeOffset(
      dx,
      width,
      next >= 0 && next <= 2,
    );
    options
      .track()
      .style.setProperty("--workspace-drag", `${String(offset)}px`);
  };
  const finish = (event: PointerEvent, cancel = false) => {
    const g = gesture;
    if (!g || g.id !== event.pointerId) return;
    if (g.axis !== "horizontal") {
      gesture = undefined;
      return;
    }
    const dx = event.clientX - g.x,
      width = host.clientWidth;
    const velocity = event.timeStamp - g.lastAt < 100 ? g.velocity : 0;
    const next = options.index() + (dx < 0 ? 1 : -1);
    const commit =
      !cancel &&
      options.enabled() &&
      options.physics.shouldCommitSwipe({
        dx,
        dy: event.clientY - g.y,
        width,
        velocityX: velocity,
        axis: g.axis,
        hasTarget: next >= 0 && next <= 2,
      });
    const target = commit ? Math.sign(dx) * width : 0;
    const duration = options.physics.swipeSettleDurationMs({
      remainingDistance: Math.abs(target - offset),
      width,
      velocityX: velocity,
      reducedMotion: reduced.matches,
    });
    const track = options.track();
    settling = true;
    gesture = undefined;
    suppress = performance.now() + duration + 120;
    track.dataset.settling = "true";
    track.style.setProperty("--workspace-duration", `${String(duration)}ms`);
    track.style.setProperty("--workspace-drag", `${String(target)}px`);
    timer = setTimeout(() => {
      clear();
      if (commit) options.select(next);
      options.settled();
    }, duration);
  };
  const up = (event: PointerEvent) => {
    finish(event);
  };
  const cancel = (event: PointerEvent) => {
    finish(event, true);
  };
  const lostCapture = (event: PointerEvent) => {
    // Touch transfers implicit capture from the hit child to the workspace.
    if (event.target === host) cancel(event);
  };
  const click = (event: MouseEvent) => {
    if (
      options.enabled() &&
      event.detail !== 0 &&
      performance.now() < suppress
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  host.addEventListener("pointerdown", down);
  host.addEventListener("pointermove", move);
  host.addEventListener("pointerup", up);
  host.addEventListener("pointercancel", cancel);
  host.addEventListener("lostpointercapture", lostCapture);
  host.addEventListener("click", click, true);
  return {
    active: () => settling || gesture?.axis === "horizontal",
    dispose() {
      clear();
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerup", up);
      host.removeEventListener("pointercancel", cancel);
      host.removeEventListener("lostpointercapture", lostCapture);
      host.removeEventListener("click", click, true);
    },
  };
}
