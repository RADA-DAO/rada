import { drawFrogColors, type ColorDrop } from "../../jpegpe/index.ts";
import type { PaymentView, PostgresPaymentStore } from "../../wallet/index.ts";
import type {
  ClaimDb,
  CompleteResult,
  OwnClaim,
  PrepareRefusal,
} from "./claims.ts";

/** The wallet app id of SPLASH claim intents (purpose `splash:<frog id>`). */
export const SPLASH_APP_ID = "splash";
export type ClaimPayments = Pick<
  PostgresPaymentStore,
  "preparePlatform" | "reconcileAs" | "cancelAs"
>;
export type DrawColors = (input: {
  frogId: string;
  requestId: string;
  round: number;
}) => Promise<ColorDrop>;
export type StartRefusal =
  PrepareRefusal | "wallet_not_linked" | "payment_pending" | "conflict";
export type StartResult =
  | { status: "ready" | "paid"; payment: PaymentView }
  | { status: "payment_pending"; payment: PaymentView }
  | { status: Exclude<StartRefusal, "payment_pending"> };

/**
 * Claims: the winner pays exactly the winning bid in JPEGPE through a wallet
 * platform intent; SQL settles a payment confirmed on chain before the deadline
 * exactly once, and burns an unpaid win after the deadline.
 */
export class ClaimService {
  private db: ClaimDb;
  private payments: ClaimPayments;
  private colors: DrawColors;
  private log: (line: string) => void;
  constructor(
    db: ClaimDb,
    payments: ClaimPayments,
    colors: DrawColors = drawFrogColors,
    log: (line: string) => void = console.log,
  ) {
    this.db = db;
    this.payments = payments;
    this.colors = colors;
    this.log = log;
  }

  /** `sender` is a raw (`0:<hex>`) address of one of the caller's linked wallets. */
  async start(
    telegramId: string,
    submissionId: string,
    sender: string,
    username: string | null,
  ): Promise<StartResult> {
    const subject = await this.db.subjectOf(telegramId);
    const terms = await this.db.prepare(subject, submissionId, username);
    if (terms.status !== "ready") return { status: terms.status };
    let attempt = terms.nextAttempt;
    if (terms.open) {
      const current = await this.payments.reconcileAs(
        subject,
        SPLASH_APP_ID,
        terms.open.intentId,
      );
      if (current.status === "paid") {
        await this.settleFrog(submissionId);
        return { status: "paid", payment: current };
      }
      if (current.status === "unknown")
        return { status: "payment_pending", payment: current };
      const sameTerms =
        terms.open.sender === sender &&
        terms.open.recipient === terms.recipient;
      if (current.status === "prepared" && sameTerms) attempt -= 1;
      else if (current.status === "prepared") {
        // Only one attempt may be payable at a time: the old one must be cancelled.
        const cancelled = await this.payments.cancelAs(
          subject,
          SPLASH_APP_ID,
          current.intentId,
        );
        if (cancelled.status !== "cancelled")
          return { status: "payment_pending", payment: cancelled };
      }
    }
    let payment: PaymentView;
    try {
      payment = await this.payments.preparePlatform(
        subject,
        {
          appId: SPLASH_APP_ID,
          idempotencyKey: `claim-${submissionId}-${String(attempt)}`,
          token: "JPEGPE",
          amount: terms.amount,
          recipient: terms.recipient,
          sender,
          purpose: `splash:${submissionId}`,
        },
        terms.signBefore,
      );
    } catch (error) {
      // Wallet errors carry stable names (PaymentDenied: sender not linked).
      const name = error instanceof Error ? error.name : "";
      if (name === "PaymentDenied") return { status: "wallet_not_linked" };
      if (name === "PaymentConflict") return { status: "conflict" };
      throw error;
    }
    const recorded = await this.db.record(
      subject,
      submissionId,
      attempt,
      payment.intentId,
    );
    if (recorded === "recorded") return { status: "ready", payment };
    if (recorded === "claim_expired") return { status: "claim_expired" };
    if (recorded === "terms_mismatch")
      throw new Error("claim intent does not match its terms");
    return { status: recorded === "conflict" ? "conflict" : "not_found" };
  }

  /** The caller's claim of one frog, after checking its latest payment on chain. */
  async status(
    telegramId: string,
    submissionId: string,
  ): Promise<OwnClaim | null> {
    const subject = await this.db.subjectOf(telegramId);
    const claim = (await this.db.mine(subject, submissionId))[0];
    if (!claim) return null;
    if (
      claim.intentId &&
      claim.state !== "claimed" &&
      claim.state !== "burned"
    ) {
      const payment = await this.payments.reconcileAs(
        subject,
        SPLASH_APP_ID,
        claim.intentId,
      );
      if (payment.status === "paid") await this.settleFrog(submissionId);
      return (await this.db.mine(subject, submissionId))[0] ?? null;
    }
    return claim;
  }

  async mine(telegramId: string): Promise<OwnClaim[]> {
    return await this.db.mine(await this.db.subjectOf(telegramId));
  }

  /** Steward only; null otherwise. `recipient` is a raw mainnet address. */
  async setRecipient(telegramId: string, recipient: string) {
    return await this.db.setRecipient(
      await this.db.subjectOf(telegramId),
      recipient,
    );
  }

  /**
   * The timer step: per unsettled win, re-check signed attempts on chain, then
   * complete a payment confirmed before the deadline or burn after the grace
   * period. A chain read failure skips that frog (never burns on doubt).
   */
  async settle(now: () => number = Date.now): Promise<void> {
    const ids = new Set(
      (await this.db.openClaims()).map((row) => row.submissionId),
    );
    for (const submissionId of ids) {
      try {
        await this.settleFrog(submissionId, now);
      } catch (error) {
        this.log(
          JSON.stringify({
            event: "splash_claim_settle_failed",
            errorClass: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
  }

  private async settleFrog(
    submissionId: string,
    now: () => number = Date.now,
  ): Promise<CompleteResult | "burned_now" | "waiting"> {
    return await this.db.withLockedClaim(submissionId, async (db, rows) => {
      const absent: string[] = [];
      let complete = true;
      for (const row of rows) {
        if (!row.intentId) continue;
        if (row.paymentStatus === "unknown") {
          const result = await this.payments.reconcileAs(
            row.winnerSubjectId,
            SPLASH_APP_ID,
            row.intentId,
            Math.floor(row.burnAfter.getTime() / 1000),
          );
          if (result.scanStatus === "confirmed-absent")
            absent.push(row.intentId);
          else complete = false;
        } else if (
          row.paymentStatus !== "cancelled" &&
          row.paymentStatus !== "prepared" &&
          row.paymentStatus !== "paid"
        ) {
          complete = false;
        }
      }
      const paid = await db.claimPayment(submissionId);
      if (paid) {
        const drop = await this.colors({
          frogId: submissionId,
          requestId: paid.intentId,
          round: paid.colorRound,
        });
        return await db.complete(submissionId, drop);
      }
      const burnAfter = rows[0]?.burnAfter;
      if (complete && burnAfter && now() >= burnAfter.getTime())
        return (await db.burn(submissionId, absent)) ? "burned_now" : "waiting";
      return "waiting";
    });
  }
}
