import { isKeyboardInput } from "./keyboard.ts";
import type { Navigation } from "./navigation.ts";

/** Desktop Escape means Back. A native dialog or a text field consumes Escape first. */
export function installEscapeBack(navigation: Navigation) {
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
      return;
    if (document.querySelector("dialog[open]")) return;
    if (isKeyboardInput(document.activeElement)) return;
    if (navigation.back()) event.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  return () => {
    document.removeEventListener("keydown", onKey);
  };
}
