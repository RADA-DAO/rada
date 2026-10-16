import { element, uniqueId } from "./dom.ts";

type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export type FieldOptions = {
  label: string;
  kind?: "text" | "textarea" | "select";
  value?: string;
  name?: string;
  /** Required for `select`. */
  choices?: { value: string; label: string }[];
  error?: string;
  required?: boolean;
  maxLength?: number;
  rows?: number;
  onChange?: (value: string) => void;
};

export type Field = {
  element: HTMLElement;
  control: Control;
  /** Show a message under the field, or clear it with no argument. */
  setError(message?: string): void;
};

export function Field(options: FieldOptions): Field {
  const kind = options.kind ?? "text";
  const control: Control =
    kind === "textarea"
      ? element("textarea", "rada-field-control")
      : kind === "select"
        ? element("select", "rada-field-control")
        : element("input", "rada-field-control");
  if (kind === "select")
    for (const choice of options.choices ?? []) {
      const option = element("option", "", choice.label);
      option.value = choice.value;
      control.append(option);
    }
  if (kind === "select") control.setAttribute("aria-label", options.label);
  if (options.name) control.name = options.name;
  if (options.required) control.required = true;
  if (kind !== "select") {
    const text = control as HTMLInputElement | HTMLTextAreaElement;
    if (options.maxLength !== undefined) text.maxLength = options.maxLength;
  }
  if (kind === "textarea" && options.rows !== undefined)
    (control as HTMLTextAreaElement).rows = options.rows;
  if (options.value !== undefined) control.value = options.value;
  if (options.onChange) {
    const notify = options.onChange;
    control.addEventListener("change", () => {
      notify(control.value);
    });
  }
  const label = element("label", "rada-field-label");
  label.append(element("span", "rada-field-text", options.label), control);
  const error = element("p", "rada-field-error");
  error.id = uniqueId("rada-field-error");
  error.setAttribute("role", "alert");
  const root = element("div", "rada-field");
  root.append(label, error);
  const setError = (message?: string) => {
    error.textContent = message ?? "";
    error.hidden = !message;
    if (message) {
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", error.id);
    } else {
      control.removeAttribute("aria-invalid");
      control.removeAttribute("aria-describedby");
    }
  };
  setError(options.error);
  return { element: root, control, setError };
}
