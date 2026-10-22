import { parseUnits } from "../../../packages/i18n/src/index.ts";
import {
  Button,
  Field,
  LiveRegion,
  openSheet,
  Picture,
  setButtonLoading,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { Lot, OwnBid } from "./api.ts";
import { aborted, errorText, type SplashContext } from "./context.ts";
import { JPEGPE_DECIMALS } from "./format.ts";
import { nameField } from "./name-field.ts";

export function wholeBidUnits(value: string): string | null {
  return /^[1-9][0-9]*$/.test(value)
    ? parseUnits(value, JPEGPE_DECIMALS)
    : null;
}

const amountErrors = new Set(["invalid_amount"]);
const nameErrors = new Set(["invalid_name", "name_taken"]);

/**
 * The bid sheet: amount and proposed permanent name. A bid is a promise paid
 * at claim; Back, swipe and Escape close it without placing anything.
 */
export function openBidSheet(
  context: SplashContext,
  lot: Lot,
  own: OwnBid | undefined,
  options: {
    opener: HTMLElement | null;
    onPlaced(nameContested: boolean): void;
  },
): void {
  const { text } = context;
  const controller = new AbortController();
  const amount = Field({
    label: text("splash.bidAmountLabel"),
    inputMode: "numeric",
    value: own
      ? String(BigInt(own.amount) / 10n ** BigInt(JPEGPE_DECIMALS))
      : "",
  });
  amount.control.setAttribute("autocomplete", "off");
  amount.element.classList.add("splash-bid-number");
  amount.control.setAttribute("placeholder", text("splash.numberPlaceholder"));
  const suffix = document.createElement("span");
  suffix.className = "splash-number-suffix";
  suffix.textContent = text("splash.tokenSymbol");
  suffix.setAttribute("aria-hidden", "true");
  amount.element.querySelector("label")?.append(suffix);
  const name = nameField(context, own?.name ?? "", true);
  const status = LiveRegion();
  const place = Button(text(own ? "splash.editBid" : "splash.placeBid"), {
    variant: "primary",
    onClick: () => void submit(),
  });
  async function submit() {
    amount.setError();
    name.setError();
    status.replaceChildren();
    const units = wholeBidUnits(amount.control.value);
    if (!units) {
      amount.setError(text("splash.error.invalid_amount"));
      amount.control.focus();
      return;
    }
    const nameError = name.error();
    if (nameError) {
      name.setError(text(nameError));
      name.control.focus();
      return;
    }
    setButtonLoading(place, true);
    try {
      const placed = await context.client.placeBid(
        lot.submissionId,
        units,
        name.value(),
        controller.signal,
      );
      dialog.close();
      options.onPlaced(placed.nameContested);
    } catch (error) {
      if (aborted(controller.signal, error)) return;
      const code = error instanceof Error ? error.message : "";
      const message = errorText(text, error);
      if (amountErrors.has(code)) amount.setError(message);
      else if (nameErrors.has(code)) name.setError(message);
      else status.replaceChildren(Text(message));
    } finally {
      setButtonLoading(place, false);
    }
  }
  for (const control of [name.control, amount.control])
    control.addEventListener("keydown", (event) => {
      if (
        !(event instanceof KeyboardEvent) ||
        event.key !== "Enter" ||
        event.isComposing
      )
        return;
      event.preventDefault();
      if (!place.disabled) void submit();
    });
  const arrow = document.createElement("span");
  arrow.className = "splash-bid-arrow";
  arrow.textContent = text("splash.actionArrow");
  arrow.setAttribute("aria-hidden", "true");
  place.append(arrow);
  const dialog = openSheet({
    title: text(own ? "splash.editTitle" : "splash.bidTitle"),
    closeLabel: text("common.close"),
    navigation: context.navigation,
    opener: options.opener,
    onClose: () => {
      controller.abort();
      name.dispose();
    },
    children: [
      Picture({
        src: lot.imageUrl,
        alt: text("splash.frogAlt"),
        fallback: text("splash.imageMissing"),
        size: "thumb",
      }),
      Text(text("splash.bidIntro")),
      name.element,
      amount.element,
      Text(text("splash.bidPaymentNote")),
      status,
      place,
    ],
  });
  dialog.classList.add(
    "splash-sheet",
    "splash-sheet--bid",
    "splash-sheet--entry",
  );
  const artwork = dialog.querySelector("figure");
  if (artwork) dialog.prepend(artwork);
  const header = dialog.querySelector(".rada-sheet-header");
  const eyebrow = Text(text("splash.bidEyebrow"));
  eyebrow.classList.add("splash-bid-eyebrow");
  header?.prepend(eyebrow);
  const close = header?.querySelector("button");
  if (close) {
    close.textContent = text("splash.closeSymbol");
    close.classList.add("splash-bid-close");
  }
  name.control.focus();
}
