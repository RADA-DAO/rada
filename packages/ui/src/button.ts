import { element } from "./dom.ts";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export type ButtonOptions = {
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
  variant?: ButtonVariant;
  loading?: boolean;
  /** Icon-only control; label remains its accessible name. */
  icon?: "settings";
  /** Accessible name when it must differ from the visible label. */
  ariaLabel?: string;
};

export function Button(
  label: string,
  options: ButtonOptions = {},
): HTMLButtonElement {
  const button = element(
    "button",
    `rada-button rada-button--${options.variant ?? "secondary"}`,
    label,
  );
  if (options.icon) {
    button.textContent = "";
    button.dataset.icon = options.icon;
    button.setAttribute("aria-label", options.ariaLabel ?? label);
  }
  button.type = options.type ?? "button";
  button.disabled = options.disabled ?? false;
  if (options.ariaLabel) button.setAttribute("aria-label", options.ariaLabel);
  if (options.onClick) button.addEventListener("click", options.onClick);
  if (options.loading) setButtonLoading(button, true);
  return button;
}

/** A loading button is disabled and busy; ending the load restores the prior disabled state. */
export function setButtonLoading(
  button: HTMLButtonElement,
  loading: boolean,
): void {
  const active = button.dataset.loading === "true";
  if (loading === active) return;
  if (loading) {
    button.dataset.loading = "true";
    button.dataset.wasDisabled = String(button.disabled);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }
  delete button.dataset.loading;
  button.disabled = button.dataset.wasDisabled === "true";
  delete button.dataset.wasDisabled;
  button.removeAttribute("aria-busy");
}
