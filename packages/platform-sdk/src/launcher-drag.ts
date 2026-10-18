/** Platform gesture ownership: drag only a dedicated handle; scroll remains native elsewhere. */
export function installLauncherDrag(
  handle: HTMLElement,
  target: () => HTMLElement[],
  move: (index: number) => void,
) {
  let pointer: number | undefined;
  handle.style.touchAction = "none";
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointer = event.pointerId;
    handle.setPointerCapture(pointer);
    event.stopPropagation();
  });
  handle.addEventListener("pointerup", (event) => {
    if (pointer !== event.pointerId) return;
    pointer = undefined;
    const at = target().findIndex((node) => {
      const r = node.getBoundingClientRect();
      return event.clientY >= r.top && event.clientY <= r.bottom;
    });
    if (at >= 0) move(at);
  });
  handle.addEventListener("pointercancel", () => {
    pointer = undefined;
  });
}
