import { Button, Sheet } from "../../ui/src/index.ts";
import type { ConsentCopy } from "./app-host.ts";

export function consentWindow(
  copy: ConsentCopy,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let result = false;
    const description = document.createElement("p");
    description.textContent = copy.description;
    const allow = Button(copy.allow, {
      onClick: () => {
        result = true;
        dialog.close();
      },
    });
    const dialog = Sheet({
      title: copy.title,
      closeLabel: copy.deny,
      children: [description, allow],
    });
    const abort = () => {
      dialog.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    dialog.addEventListener(
      "close",
      () => {
        signal.removeEventListener("abort", abort);
        dialog.remove();
        resolve(result && !signal.aborted);
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}
