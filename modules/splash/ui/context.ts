import type { Locale, MessageKey } from "../../../packages/i18n/src/index.ts";
import type { SheetNavigation } from "../../../packages/ui/src/index.ts";
import { ErrorState, Loading } from "../../../packages/ui/src/index.ts";
import type { SplashClient } from "./api.ts";
import type { Text } from "./format.ts";

export type SplashRoute =
  "splash" | "splash-submit" | "splash-mine" | "splash-results";
export const SPLASH_ROUTES: readonly SplashRoute[] = [
  "splash",
  "splash-submit",
  "splash-mine",
  "splash-results",
];

/** Payment window outcome; `unknown` means sent but not yet confirmed on chain. */
export type PayResult = {
  status: "prepared" | "unknown" | "paid" | "cancelled";
};

/** What every SPLASH screen receives from the shell for one mount. */
export type SplashContext = {
  locale: Locale;
  text: Text;
  client: SplashClient;
  /** A signed Telegram launch; guests can only browse. */
  authenticated: boolean;
  navigation: SheetNavigation;
  /** Aborted when the screen leaves or the language changes. */
  signal: AbortSignal;
  open(route: SplashRoute): void;
  /** Leave this screen, as Back would. */
  back(): void;
  /** The profile screen, where wallets are connected and linked. */
  openWallet(): void;
  connectedWallet(signal: AbortSignal): Promise<string | null>;
  /** Opens the platform payment window for a server-prepared intent. */
  pay(intent: unknown, signal: AbortSignal): Promise<PayResult>;
};

const known = new Set([
  "expired",
  "rate_limited",
  "duplicate_image",
  "bad_dimensions",
  "invalid_image",
  "too_large",
  "unsupported_type",
  "invalid_amount",
  "invalid_name",
  "self_bid",
  "not_on_auction",
  "name_taken",
  "round_closed",
  "not_winner",
  "wallet_not_linked",
  "wallet_unavailable",
  "already_claimed",
  "burned",
  "claim_expired",
  "name_required",
  "payment_pending",
  "recipient_unset",
  "fee_unavailable",
  "fee_expired",
  "wallet_changed",
]);

/** A translated sentence for an API or payment error code. */
export function errorText(text: Text, error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  return text(
    (known.has(code)
      ? `splash.error.${code}`
      : "splash.error.unavailable") as MessageKey,
  );
}

export const aborted = (signal: AbortSignal, error?: unknown): boolean =>
  signal.aborted || (error instanceof Error && error.name === "AbortError");

/** Shows a loading line in `container` while `load` runs, then its result or a retry. */
export async function loadInto(
  context: SplashContext,
  container: HTMLElement,
  load: () => Promise<Node[]>,
  failureKey?: MessageKey,
): Promise<void> {
  if (!container.childNodes.length)
    container.replaceChildren(
      Loading({ message: context.text("splash.loading") }),
    );
  try {
    const nodes = await load();
    if (!context.signal.aborted) {
      const previous = document.activeElement;
      const returnToHeading =
        previous instanceof HTMLElement &&
        container.contains(previous) &&
        !previous.dataset.focusKey;
      const focusKey =
        previous instanceof HTMLElement && container.contains(previous)
          ? previous.dataset.focusKey
          : undefined;
      container.replaceChildren(...nodes);
      if (focusKey) {
        const replacement = [
          ...container.querySelectorAll<HTMLElement>("[data-focus-key]"),
        ].find((node) => node.dataset.focusKey === focusKey);
        replacement?.focus();
      }
      if (returnToHeading) {
        const heading = container.querySelector<HTMLElement>("h2");
        if (heading) {
          heading.tabIndex = -1;
          heading.focus();
        }
      }
    }
  } catch (error) {
    if (aborted(context.signal, error)) return;
    container.replaceChildren(
      ErrorState({
        message: failureKey
          ? context.text(failureKey)
          : errorText(context.text, error),
        retryLabel: context.text("common.retry"),
        onRetry: () => void loadInto(context, container, load, failureKey),
      }),
    );
  }
}
