export {
  compileTheme,
  contrastRatio,
  DEFAULT_THEME_BACKGROUND,
  normalizedHexColor,
  semanticAccentFallback,
  type ThemePalette,
} from "./theme-compiler.ts";

export const RADA_THEME_TOKEN_NAMES = [
  "--theme-base",
  "--accent-solid",
  "--theme-ring",
  "--water-top",
  "--water-mid",
  "--water-bottom",
  "--environment-top",
  "--environment-mid",
  "--environment-bottom",
  "--accent",
  "--accent-2",
  "--accent-3",
  "--accent-sun",
  "--accent-rgb",
  "--ink",
  "--ink-rgb",
  "--muted",
  "--text-primary",
  "--text-muted",
  "--shadow-rgb",
  "--surface-pigment",
  "--surface-highlight",
  "--surface-shadow",
  "--surface-base",
  "--surface-raised",
  "--surface-soft",
  "--glass-fill",
  "--glass-fill-strong",
  "--glass-fill-soft",
  "--glass-edge",
  "--glass-edge-bottom",
  "--glass-glint",
  "--accent-soft",
  "--accent-strong",
  "--accent-indicator",
  "--accent-ink",
  "--accent-ring",
  "--control-primary-bg",
  "--control-primary-ink",
  "--control-primary-border",
  "--control-secondary-bg",
  "--control-secondary-ink",
  "--control-secondary-border",
  "--control-selected-bg",
  "--control-selected-ink",
  "--control-disabled-bg",
  "--control-disabled-ink",
] as const;

export function applyTheme(
  root: HTMLElement,
  palette: { tokens: Record<string, string> },
): void {
  for (const [name, value] of Object.entries(palette.tokens))
    root.style.setProperty(name, value);
}

export function Button(
  label: string,
  options: {
    onClick?: () => void;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  } = {},
): HTMLButtonElement {
  const element = document.createElement("button");
  element.className = "rada-button";
  element.type = options.type ?? "button";
  element.textContent = label;
  element.disabled = options.disabled ?? false;
  if (options.onClick) element.addEventListener("click", options.onClick);
  return element;
}

export function Card(
  options: { children?: Node[]; label?: string } = {},
): HTMLElement {
  const element = document.createElement("section");
  element.className = "rada-card";
  if (options.label) element.setAttribute("aria-label", options.label);
  for (const child of options.children ?? []) element.append(child);
  return element;
}

export function Sheet(options: {
  title: string;
  children?: Node[];
  closeLabel: string;
  onClose?: () => void;
}): HTMLDialogElement {
  const headingId = `rada-sheet-title-${++sheetSequence}`;
  const element = document.createElement("dialog");
  element.className = "rada-sheet";
  element.setAttribute("aria-labelledby", headingId);
  const heading = document.createElement("h2");
  heading.id = headingId;
  heading.textContent = options.title;
  const close = Button(options.closeLabel, {
    onClick: options.onClose ?? (() => element.close()),
  });
  close.setAttribute("aria-label", options.closeLabel);
  element.append(heading, close, ...(options.children ?? []));
  return element;
}

export function EmptyState(options: {
  message: string;
  title?: string;
}): HTMLElement {
  return state("rada-empty-state", options.title, options.message, "status");
}

export function ErrorState(options: {
  message: string;
  title?: string;
  retryLabel?: string;
  onRetry?: () => void;
}): HTMLElement {
  const element = state(
    "rada-error-state",
    options.title,
    options.message,
    "alert",
  );
  if (options.retryLabel && options.onRetry)
    element.append(Button(options.retryLabel, { onClick: options.onRetry }));
  return element;
}

let sheetSequence = 0;

function state(
  className: string,
  title: string | undefined,
  message: string,
  role: "status" | "alert",
): HTMLElement {
  const element = document.createElement("section");
  element.className = className;
  element.setAttribute("role", role);
  if (title) {
    const heading = document.createElement("h2");
    heading.textContent = title;
    element.append(heading);
  }
  const description = document.createElement("p");
  description.textContent = message;
  element.append(description);
  return element;
}
