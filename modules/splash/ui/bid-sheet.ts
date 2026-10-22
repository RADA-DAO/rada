import { parseUnits } from "../../../packages/i18n/src/index.ts";
import {
  Button,
  Facts,
  Field,
  LiveRegion,
  openSheet,
  Picture,
  setButtonLoading,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { Lot, OwnBid } from "./api.ts";
import { aborted, errorText, type SplashContext } from "./context.ts";
import { jpegpe, JPEGPE_DECIMALS } from "./format.ts";
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
  const { text, locale } = context;
  const controller = new AbortController();
  const amount = Field({
    label: text("splash.bidAmountLabel"),
    inputMode: "numeric",
    hint: own
      ? text("splash.bidEditHint", { amount: jpegpe(locale, own.amount) })
      : text("splash.bidAmountHint"),
  });
  amount.control.setAttribute("autocomplete", "off");
  const name = nameField(context, own?.name ?? "");
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
      Facts([
        { label: text("splash.bidders"), value: String(lot.bidderCount) },
        ...(own
          ? [
              {
                label: text("splash.yourBid"),
                value: jpegpe(locale, own.amount),
              },
            ]
          : []),
      ]),
      Text(text("splash.bidRule")),
      amount.element,
      name.element,
      Text(text("splash.promise")),
      Text(text("splash.burnRule")),
      status,
      place,
    ],
  });
  amount.control.focus();
}
