import {
  Button,
  Text,
  openSheet,
  type SheetNavigation,
} from "../../ui/src/index.ts";
import type { ConsentCopy } from "./app-host.ts";

/** Ask once for a permission in a platform sheet; Back, Escape and swipe deny. */
export function consentWindow(
  copy: ConsentCopy,
  signal: AbortSignal,
  navigation?: SheetNavigation,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let result = false;
    const allow = Button(copy.allow, {
      onClick: () => {
        result = true;
        dialog.close();
      },
    });
    const abort = () => {
      dialog.close();
    };
    const dialog = openSheet({
      title: copy.title,
      closeLabel: copy.deny,
      children: [Text(copy.description), allow],
      ...(navigation ? { navigation } : {}),
      onClose: () => {
        signal.removeEventListener("abort", abort);
        resolve(result && !signal.aborted);
      },
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
