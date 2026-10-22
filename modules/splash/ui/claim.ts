import type { MessageKey } from "../../../packages/i18n/src/index.ts";
import {
  Button,
  Countdown,
  Facts,
  LiveRegion,
  openSheet,
  setButtonLoading,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { Claim } from "./api.ts";
import { aborted, errorText, type SplashContext } from "./context.ts";
import { clock, jpegpe, utcMoment } from "./format.ts";
import { nameField } from "./name-field.ts";

const walletProblems = new Set(["wallet_not_linked", "wallet_unavailable"]);

/** After the payment window: what the server now says about the claim. */
async function outcome(
  context: SplashContext,
  frogId: string,
  status: string,
): Promise<MessageKey> {
  if (status === "cancelled") return "splash.claimCancelled";
  const claim = await context.client.claim(frogId, context.signal);
  if (claim.state === "claimed") return "splash.claimDone";
  if (claim.state === "burned") return "splash.claimBurned";
  return "splash.claimPending";
}

/**
 * Claim a won frog: choose a name if the win has none, then pay exactly the
 * winning bid in the platform payment window from a linked wallet.
 */
export function openClaimSheet(
  context: SplashContext,
  claim: Claim,
  options: { opener: HTMLElement | null; onDone(message: string): void },
): void {
  const { text, locale } = context;
  const controller = new AbortController();
  const name = claim.name === null ? nameField(context) : undefined;
  const status = LiveRegion();
  const left = Countdown({
    until: claim.claimDeadline,
    label: text("splash.claimLeftLabel"),
    format: clock,
  });
  const pay = Button(text("splash.continueToPayment"), {
    variant: "primary",
    onClick: () => void start(),
  });
  function walletHelp(error: unknown) {
    status.replaceChildren(
      Text(errorText(text, error)),
      Button(text("splash.openWallet"), {
        onClick: () => {
          dialog.close();
          context.openWallet();
        },
      }),
    );
  }
  async function start() {
    status.replaceChildren();
    const nameError = name?.error();
    if (name && nameError) {
      name.setError(text(nameError));
      name.control.focus();
      return;
    }
    setButtonLoading(pay, true);
    // Set once this sheet closes itself to hand over to the payment window.
    let handedOff = false;
    try {
      const sender = await context.connectedWallet(controller.signal);
      if (!sender) {
        walletHelp(new Error("wallet_unavailable"));
        return;
      }
      const started = await context.client.startClaim(
        claim.submissionId,
        sender,
        name ? name.value() : null,
        controller.signal,
      );
      handedOff = true;
      dialog.close();
      if (started.status === "paid") {
        options.onDone(
          text(await outcome(context, claim.submissionId, "paid")),
        );
        return;
      }
      // The claim sheet is closed: the payment window is the only sheet now.
      const paid = await context.pay(started.payment, context.signal);
      options.onDone(
        text(await outcome(context, claim.submissionId, paid.status)),
      );
    } catch (error) {
      if (context.signal.aborted) return;
      if (!handedOff && aborted(controller.signal, error)) return;
      const code = error instanceof Error ? error.message : "";
      if (dialog.open && walletProblems.has(code)) walletHelp(error);
      else if (dialog.open && name && code === "name_taken")
        name.setError(errorText(text, error));
      else if (dialog.open)
        status.replaceChildren(Text(errorText(text, error)));
      else
        options.onDone(
          code === "payment_pending"
            ? text("splash.claimPending")
            : errorText(text, error),
        );
    } finally {
      setButtonLoading(pay, false);
    }
  }
  const dialog = openSheet({
    title: text("splash.claimTitle"),
    closeLabel: text("common.close"),
    navigation: context.navigation,
    opener: options.opener,
    onClose: () => {
      controller.abort();
      left.dispose();
      name?.dispose();
    },
    children: [
      Facts([
        {
          label: text("splash.claimPrice"),
          value: jpegpe(locale, claim.amount),
        },
        {
          label: text("splash.claimName"),
          value: claim.name ?? text("splash.nameAtClaim"),
        },
        {
          label: text("splash.claimDeadline"),
          value: utcMoment(locale, claim.claimDeadline),
        },
        { label: text("splash.claimLeft"), value: left.element },
      ]),
      ...(name ? [name.element] : []),
      Text(text("splash.claimExplain")),
      Text(text("splash.burnRule")),
      status,
      pay,
    ],
  });
  dialog.classList.add("splash-sheet");
}
