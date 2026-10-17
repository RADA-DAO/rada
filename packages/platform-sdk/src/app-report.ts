import {
  Button,
  Field,
  Text,
  openSheet,
  type SheetNavigation,
} from "../../ui/src/index.ts";
export type ReportCopy = {
  title: string;
  description: string;
  category: string;
  text: string;
  send: string;
  cancel: string;
  categories: Record<"bug" | "content" | "privacy" | "other", string>;
};
/** Only platform controls collect report contents; the child receives a boolean outcome. */
export function reportWindow(
  copy: ReportCopy,
  appName: string,
  signal: AbortSignal,
  navigation?: SheetNavigation,
): Promise<{ category: string; text: string } | null> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(null);
      return;
    }
    let result: { category: string; text: string } | null = null;
    const category = Field({
      label: copy.category,
      kind: "select",
      required: true,
      choices: Object.entries(copy.categories).map(([value, label]) => ({
        value,
        label,
      })),
    });
    const description = Field({
      label: copy.text,
      kind: "textarea",
      maxLength: 1000,
      rows: 4,
      required: true,
    });
    const send = Button(copy.send, {
      onClick: () => {
        if (
          !description.control.reportValidity() ||
          !description.control.value.trim()
        )
          return;
        result = {
          category: category.control.value,
          text: description.control.value.trim(),
        };
        dialog.close();
      },
    });
    const abort = () => {
      dialog.close();
    };
    const dialog = openSheet({
      title: copy.title,
      closeLabel: copy.cancel,
      children: [
        Text(appName),
        Text(copy.description),
        category.element,
        description.element,
        send,
      ],
      ...(navigation ? { navigation } : {}),
      onClose: () => {
        signal.removeEventListener("abort", abort);
        resolve(signal.aborted ? null : result);
      },
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}
