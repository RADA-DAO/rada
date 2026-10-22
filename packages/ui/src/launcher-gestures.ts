/** Optional context-menu and long-press entry into the launcher editor. */
export function installLauncherGestures(
  root: HTMLElement,
  arrange: () => void,
) {
  root.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    arrange();
  });
  let timer: ReturnType<typeof setTimeout>;
  let suppressClickUntil = 0;
  root.addEventListener(
    "click",
    (event) => {
      if (Date.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  root.addEventListener("pointerdown", (event) => {
    if (!(event.target as Element).closest(".rada-app-tile")) return;
    timer = setTimeout(() => {
      suppressClickUntil = Date.now() + 1000;
      arrange();
    }, 600);
  });
  for (const name of ["pointerup", "pointercancel", "pointermove"])
    root.addEventListener(name, () => {
      clearTimeout(timer);
    });
}
