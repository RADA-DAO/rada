import { observeScreenFocus, restoreSheetFocus } from "./focus.ts";
import { Button } from "./button.ts";
import { element, uniqueId } from "./dom.ts";

/** The slice of the platform navigation stack a sheet needs. */
export type SheetNavigation = {
  push(entry: { key: string; stale?(): boolean; leave?(): void }): void;
  drop(key: string): void;
};

export type SheetOptions = {
  title: string;
  children?: Node[];
  closeLabel: string;
};

export function Sheet(options: SheetOptions): HTMLDialogElement {
  const headingId = uniqueId("rada-sheet-title");
  const dialog = element("dialog", "rada-sheet");
  dialog.setAttribute("aria-labelledby", headingId);
  const heading = element("h2", "rada-sheet-title", options.title);
  heading.id = headingId;
  const close = Button(options.closeLabel, {
    variant: "ghost",
    onClick: () => {
      dialog.close();
    },
  });
  close.setAttribute("aria-label", options.closeLabel);
  const header = element("div", "rada-sheet-header");
  header.append(heading, close);
  const body = element("div", "rada-sheet-body");
  body.append(...(options.children ?? []));
  dialog.append(header, body);
  return dialog;
}

let active: HTMLDialogElement | undefined;
// One shared entry: Back closes whichever sheet is currently open.
const entry = {
  key: "sheet",
  stale: () => !active?.open,
  leave: () => {
    active?.close();
  },
};

export function isSheetOpen(): boolean {
  return active?.open === true;
}

/**
 * Show a modal bottom sheet and register it in the platform navigation stack, so
 * Back, swipe and Escape close it. Focus returns to `opener` afterwards.
 */
export function openSheet(
  options: SheetOptions & {
    navigation?: SheetNavigation;
    opener?: HTMLElement | null;
    onClose?: () => void;
  },
): HTMLDialogElement {
  const dialog = Sheet(options);
  const stopFocus = observeScreenFocus(dialog, "h2");
  active = dialog;
  dialog.addEventListener(
    "close",
    () => {
      stopFocus();
      dialog.remove();
      if (active === dialog) {
        active = undefined;
        options.navigation?.drop(entry.key);
      }
      options.onClose?.();
      if (!active?.open) restoreSheetFocus(options.opener);
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  options.navigation?.push(entry);
  return dialog;
}
