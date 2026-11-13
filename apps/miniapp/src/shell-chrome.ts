import { Group } from "../../../packages/ui/src/index.ts";
import type { MessageKey } from "../../../packages/i18n/src/index.ts";
import { createSettingsAction } from "./routes.ts";

/** The shared OS action stays outside pager and Back-preview movement. */
export function createShellChrome(
  root: HTMLElement,
  text: (key: MessageKey) => string,
  onClick: () => void,
) {
  const button = createSettingsAction(true, text, onClick);
  const header = Group([button]);
  header.classList.add("rada-shell-header");
  header.setAttribute("role", "banner");
  document.documentElement.dataset.radaShellChrome = "true";
  root.before(header);
  return {
    button,
    refresh() {
      button.setAttribute("aria-label", text("shell.settings"));
      const brand = button.querySelector("b");
      const os = button.querySelector("em");
      if (brand) brand.textContent = text("shell.wordmark");
      if (os) os.textContent = text("shell.os");
    },
    dispose() {
      header.remove();
      delete document.documentElement.dataset.radaShellChrome;
    },
  };
}
