import { Button } from "./button.ts";
import { element } from "./dom.ts";

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
  const error = state(
    "rada-error-state",
    options.title,
    options.message,
    "alert",
  );
  if (options.retryLabel && options.onRetry)
    error.append(Button(options.retryLabel, { onClick: options.onRetry }));
  return error;
}

export function Loading(options: { message: string }): HTMLElement {
  const loading = element("section", "rada-loading");
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-busy", "true");
  const spinner = element("span", "rada-spinner");
  spinner.setAttribute("aria-hidden", "true");
  loading.append(
    spinner,
    element("p", "rada-loading-message", options.message),
  );
  return loading;
}

function state(
  className: string,
  title: string | undefined,
  message: string,
  role: "status" | "alert",
): HTMLElement {
  const container = element("section", className);
  container.setAttribute("role", role);
  if (title) container.append(element("h2", "rada-state-title", title));
  container.append(element("p", "rada-state-message", message));
  return container;
}
