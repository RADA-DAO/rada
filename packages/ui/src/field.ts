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
  /** Virtual keyboard for text inputs, such as `decimal` for amounts. */
  inputMode?: "text" | "decimal" | "numeric";
  /** Helper text under the field; updates are announced politely. */
  hint?: string;
  onChange?: (value: string) => void;
  /** Called on every keystroke, for live checks. */
  onInput?: (value: string) => void;
};

export type Field = {
  element: HTMLElement;
  control: Control;
  /** Show a message under the field, or clear it with no argument. */
  setError(message?: string): void;
  /** Replace the helper text, or clear it with no argument. */
  setHint(message?: string): void;
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
  if (kind === "text" && options.inputMode)
    control.setAttribute("inputmode", options.inputMode);
  if (kind === "textarea" && options.rows !== undefined)
    (control as HTMLTextAreaElement).rows = options.rows;
  if (options.value !== undefined) control.value = options.value;
  if (options.onChange) {
    const notify = options.onChange;
    control.addEventListener("change", () => {
      notify(control.value);
    });
  }
  if (options.onInput) {
    const notify = options.onInput;
    control.addEventListener("input", () => {
      notify(control.value);
    });
  }
  const label = element("label", "rada-field-label");
  label.append(element("span", "rada-field-text", options.label), control);
  const error = element("p", "rada-field-error");
  error.id = uniqueId("rada-field-error");
  error.setAttribute("role", "alert");
  const hint = element("p", "rada-field-hint");
  hint.id = uniqueId("rada-field-hint");
  hint.setAttribute("aria-live", "polite");
  const root = element("div", "rada-field");
  root.append(label, hint, error);
  const describe = () => {
    const ids = [
      ...(hint.textContent ? [hint.id] : []),
      ...(error.hidden ? [] : [error.id]),
    ];
    if (ids.length) control.setAttribute("aria-describedby", ids.join(" "));
    else control.removeAttribute("aria-describedby");
  };
  const setHint = (message?: string) => {
    hint.textContent = message ?? "";
    hint.hidden = !message;
    describe();
  };
  const setError = (message?: string) => {
    error.textContent = message ?? "";
    error.hidden = !message;
    if (message) control.setAttribute("aria-invalid", "true");
    else control.removeAttribute("aria-invalid");
    describe();
  };
  setHint(options.hint);
  setError(options.error);
  return { element: root, control, setError, setHint };
}
