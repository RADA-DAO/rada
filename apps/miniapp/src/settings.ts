import { Sheet } from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
export function settingsDialog(
  locale: Locale,
  change: (locale: Locale) => void,
  close: (dialog: HTMLDialogElement) => void,
): HTMLDialogElement {
  const label = document.createElement("label");
  label.textContent = t(locale, "shell.language");
  const select = document.createElement("select");
  select.setAttribute("aria-label", t(locale, "shell.language"));
  for (const value of ["en", "uk"] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = t(
      locale,
      value === "en" ? "shell.english" : "shell.ukrainian",
    );
    select.append(option);
  }
  select.value = locale;
  select.onchange = () => change(select.value as Locale);
  label.append(select);
  const dialog = Sheet({
    title: t(locale, "shell.settings"),
    closeLabel: t(locale, "common.close"),
    children: [label],
  });
  dialog.addEventListener(
    "close",
    () => {
      dialog.remove();
      close(dialog);
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}
