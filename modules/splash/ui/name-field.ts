import { Field } from "../../../packages/ui/src/index.ts";
import type { SplashContext } from "./context.ts";
import { NAME_RULE } from "./format.ts";

/**
 * The proposed permanent frog name with a live availability hint. The check
 * waits for a typing pause and only the latest answer is shown.
 */
export function nameField(
  context: SplashContext,
  initial = "",
  bidSheet = false,
) {
  const { text } = context;
  let latest: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let status: "available" | "taken" | "invalid" | "unknown" = "unknown";
  const field = Field({
    label: text(bidSheet ? "splash.bidNameLabel" : "splash.nameLabel"),
    value: initial,
    maxLength: 32,
    hint: text("splash.nameRule"),
    onInput: (value) => {
      check(value);
    },
  });
  if (bidSheet) {
    field.element.classList.add("splash-bid-name");
    field.control.setAttribute("placeholder", text("splash.namePlaceholder"));
    const hint = document.createElement("span");
    hint.className = "splash-name-timing";
    hint.textContent = text("splash.nameTiming");
    hint.setAttribute("aria-hidden", "true");
    field.element.append(hint);
    field.element
      .querySelector(".rada-field-hint")
      ?.classList.add("rada-visually-hidden");
  }
  field.control.setAttribute("autocomplete", "off");
  field.control.setAttribute("autocapitalize", "off");
  field.control.setAttribute("spellcheck", "false");
  function setHint(message: string) {
    field.setHint(message);
    if (bidSheet)
      field.element
        .querySelector(".rada-field-hint")
        ?.classList.toggle(
          "rada-visually-hidden",
          message === text("splash.nameRule"),
        );
  }
  function check(value: string) {
    latest?.abort();
    clearTimeout(timer);
    field.setError();
    if (!value) {
      status = "unknown";
      setHint(text("splash.nameRule"));
      return;
    }
    if (!NAME_RULE.test(value)) {
      status = "invalid";
      setHint(text("splash.nameRule"));
      return;
    }
    status = "unknown";
    setHint(text("splash.nameChecking"));
    const controller = new AbortController();
    latest = controller;
    timer = setTimeout(() => {
      context.client
        .nameStatus(value, controller.signal)
        .then((result) => {
          if (latest !== controller || context.signal.aborted) return;
          status = result;
          setHint(
            text(
              result === "available"
                ? "splash.nameAvailable"
                : result === "taken"
                  ? "splash.nameTaken"
                  : "splash.nameRule",
            ),
          );
        })
        .catch(() => {
          if (latest !== controller) return;
          status = "unknown";
          setHint(text("splash.nameUnchecked"));
        });
    }, 350);
  }
  if (initial) check(initial);
  return {
    element: field.element,
    control: field.control,
    setError: (message?: string) => {
      field.setError(message);
    },
    value: () => field.control.value.trim(),
    error: () =>
      !field.control.value.trim()
        ? ("splash.nameRequired" as const)
        : !NAME_RULE.test(field.control.value.trim()) || status === "invalid"
          ? ("splash.error.invalid_name" as const)
          : status === "taken"
            ? ("splash.error.name_taken" as const)
            : undefined,
    dispose: () => {
      latest?.abort();
      clearTimeout(timer);
    },
  };
}
