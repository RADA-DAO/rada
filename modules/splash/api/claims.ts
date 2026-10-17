import type pg from "pg";
import type { ColorDrop } from "../../jpegpe/index.ts";
import type { NameOutcome } from "./rounds.ts";

export type ClaimState =
  "open" | "expired" | "claimed" | "burned" | "needs_manual_review";
export type ClaimPaymentStatus = "prepared" | "unknown" | "paid" | "cancelled";
/** A win of the caller with its claim state. */
export type OwnClaim = {
  submissionId: string;
  roundId: number;
  /** Smallest JPEGPE units, exactly the winning bid. */
  amount: string;
  /** Held name (open), permanent name (claimed), or null. */
  username: string | null;
  nameOutcome: NameOutcome;
  claimDeadline: string;
  state: ClaimState;
  backgroundColor: string | null;
  accentColor: string | null;
  intentId: string | null;
  paymentStatus: ClaimPaymentStatus | null;
};
export type PrepareRefusal =
  | "not_found"
  | "not_winner"
  | "already_claimed"
  | "burned"
  | "claim_expired"
  | "recipient_unset"
  | "name_fixed"
  | "name_required"
  | "invalid_name"
  | "name_taken";
export type ClaimTerms = {
  status: "ready";
  amount: string;
  recipient: string;
  username: string;
  claimDeadline: Date;
  signBefore: Date;
  nextAttempt: number;
  /** The latest attempt, if any. */
  open: { intentId: string; sender: string; recipient: string } | null;
};
export type RecordResult =
  | "recorded"
  | "conflict"
  | "claim_expired"
  | "not_claimable"
  | "terms_mismatch";
export type OpenClaimRow = {
  submissionId: string;
  winnerSubjectId: string;
  burnAfter: Date;
  intentId: string | null;
  paymentStatus: ClaimPaymentStatus | null;
};
export type CompleteResult =
  "claimed" | "already_claimed" | "burned" | "unpaid" | "not_found";

export type LockedClaim = Pick<
  ClaimDb,
  "claimPayment" | "complete" | "burn" | "review"
>;

/** The SPLASH claim tables, reached only through splash.* functions. */
export interface ClaimDb {
  subjectOf(telegramId: string): Promise<string>;
  prepare(
    subjectId: string,
    submissionId: string,
    username: string | null,
  ): Promise<ClaimTerms | { status: PrepareRefusal }>;
  record(
    subjectId: string,
    submissionId: string,
    attemptNo: number,
    intentId: string,
  ): Promise<RecordResult>;
  mine(subjectId: string, submissionId?: string): Promise<OwnClaim[]>;
  /** Null when the caller is not the SPLASH steward. */
  setRecipient(
    subjectId: string,
    recipient: string,
  ): Promise<{ recipient: string; setAt: string } | null>;
  reviews(
    subjectId: string,
  ): Promise<{ submissionId: string; state: "needs_manual_review" }[] | null>;
  review(submissionId: string): Promise<void>;
  openClaims(): Promise<OpenClaimRow[]>;
  withLockedClaim<T>(
    submissionId: string,
    run: (db: LockedClaim, rows: OpenClaimRow[]) => Promise<T>,
  ): Promise<T>;
  claimPayment(submissionId: string): Promise<{
    intentId: string;
    paidOnChainAt: Date;
    colorRound: number;
  } | null>;
  complete(submissionId: string, drop: ColorDrop): Promise<CompleteResult>;
  burn(submissionId: string, absentIntents: string[]): Promise<boolean>;
}

type Row = Record<string, unknown>;
const text = (value: unknown) => (value as string | null) ?? null;

function ownClaim(row: Row): OwnClaim {
  return {
    submissionId: row.submission_id as string,
    roundId: Number(row.round_id),
    amount: row.amount as string,
    username: text(row.username),
    nameOutcome: row.name_outcome as NameOutcome,
    claimDeadline: (row.claim_deadline as Date).toISOString(),
    state: row.state as ClaimState,
    backgroundColor: text(row.background_color),
    accentColor: text(row.accent_color),
    intentId: text(row.intent_id),
    paymentStatus: text(row.payment_status) as ClaimPaymentStatus | null,
  };
}

/** `auth` resolves Telegram ids; `service` holds only `splash_service`. */
export class PostgresClaimDb implements ClaimDb {
  private auth: pg.Pool;
  private service: pg.Pool;
  constructor(auth: pg.Pool, service: pg.Pool) {
    this.auth = auth;
    this.service = service;
  }
  async subjectOf(telegramId: string) {
    const { resolveTelegramSubject } = await import("../../identity/index.ts");
    return await resolveTelegramSubject(this.auth, telegramId);
  }
  private async asSubject<T>(
    subjectId: string,
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subjectId,
      ]);
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async prepare(
    subjectId: string,
    submissionId: string,
    username: string | null,
  ) {
    const { rows } = await this.asSubject(subjectId, (client) =>
      client.query<Row>(
        "SELECT * FROM splash.prepare_claim($1::uuid, $2::text)",
        [submissionId, username],
      ),
    );
    const row = rows[0];
    if (!row) throw new Error("prepare_claim returned no row");
    if (row.status !== "ready") return { status: row.status as PrepareRefusal };
    return {
      status: "ready" as const,
      amount: row.amount as string,
      recipient: row.recipient as string,
      username: row.username as string,
      claimDeadline: row.claim_deadline as Date,
      signBefore: row.sign_before as Date,
      nextAttempt: row.next_attempt as number,
      open: row.open_intent_id
        ? {
            intentId: row.open_intent_id as string,
            sender: row.open_sender as string,
            recipient: row.open_recipient as string,
          }
        : null,
    };
  }
  async record(
    subjectId: string,
    submissionId: string,
    attemptNo: number,
    intentId: string,
  ) {
    const { rows } = await this.asSubject(subjectId, (client) =>
      client.query<{ result: RecordResult }>(
        "SELECT splash.record_claim_attempt($1::uuid, $2::integer, $3::uuid) AS result",
        [submissionId, attemptNo, intentId],
      ),
    );
    return rows[0]?.result ?? "not_claimable";
  }
  async mine(subjectId: string, submissionId?: string) {
    const { rows } = await this.asSubject(subjectId, (client) =>
      client.query<Row>("SELECT * FROM splash.my_claims($1::uuid)", [
        submissionId ?? null,
      ]),
    );
    return rows.map(ownClaim);
  }
  async setRecipient(subjectId: string, recipient: string) {
    try {
      const { rows } = await this.asSubject(subjectId, (client) =>
        client.query<{ recipient: string; set_at: Date }>(
          "SELECT * FROM splash.set_claim_recipient($1::text)",
          [recipient],
        ),
      );
      const row = rows[0];
      if (!row) throw new Error("set_claim_recipient returned no row");
      return { recipient: row.recipient, setAt: row.set_at.toISOString() };
    } catch (error) {
      if ((error as { code?: string }).code === "42501") return null;
      throw error;
    }
  }
  async reviews(subjectId: string) {
    try {
      const { rows } = await this.asSubject(subjectId, (client) =>
        client.query<Row>("SELECT * FROM splash.claim_reviews()"),
      );
      return rows.map((row) => ({
        submissionId: row.submission_id as string,
        state: "needs_manual_review" as const,
      }));
    } catch (error) {
      if ((error as { code?: string }).code === "42501") return null;
      throw error;
    }
  }
  async review(
    submissionId: string,
    db: Pick<pg.Pool, "query"> = this.service,
  ) {
    await db.query("SELECT splash.review_claim($1::uuid)", [submissionId]);
  }
  async openClaims() {
    const { rows } = await this.service.query<Row>(
      "SELECT * FROM splash.open_claims()",
    );
    return rows.map(openClaim);
  }
  async withLockedClaim<T>(
    submissionId: string,
    run: (db: LockedClaim, rows: OpenClaimRow[]) => Promise<T>,
  ): Promise<T> {
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Row>(
        "SELECT * FROM splash.lock_claim($1::uuid)",
        [submissionId],
      );
      const value = await run(
        {
          claimPayment: (id) => this.claimPayment(id, client),
          complete: (id, drop) => this.complete(id, drop, client),
          review: (id) => this.review(id, client),
          burn: (id, absent) => this.burn(id, absent, client),
        },
        result.rows.map(openClaim),
      );
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async claimPayment(
    submissionId: string,
    db: Pick<pg.Pool, "query"> = this.service,
  ) {
    const { rows } = await db.query<Row>(
      "SELECT * FROM splash.claim_payment($1::uuid)",
      [submissionId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      intentId: row.intent_id as string,
      paidOnChainAt: row.paid_on_chain_at as Date,
      colorRound: Number(row.color_round),
    };
  }
  async complete(
    submissionId: string,
    drop: ColorDrop,
    db: Pick<pg.Pool, "query"> = this.service,
  ) {
    const { rows } = await db.query<{ result: CompleteResult }>(
      "SELECT splash.complete_claim($1::uuid, $2::jsonb, $3::jsonb) AS result",
      [
        submissionId,
        JSON.stringify(drop.background),
        JSON.stringify(drop.accent),
      ],
    );
    return rows[0]?.result ?? "not_found";
  }
  async burn(
    submissionId: string,
    absentIntents: string[],
    db: Pick<pg.Pool, "query"> = this.service,
  ) {
    const { rows } = await db.query<{ burned: boolean }>(
      "SELECT splash.burn_claim($1::uuid, $2::uuid[]) AS burned",
      [submissionId, absentIntents],
    );
    return rows[0]?.burned === true;
  }
}
function openClaim(row: Row): OpenClaimRow {
  return {
    submissionId: row.submission_id as string,
    winnerSubjectId: row.winner_subject_id as string,
    burnAfter: row.burn_after as Date,
    intentId: text(row.intent_id),
    paymentStatus: text(row.payment_status) as ClaimPaymentStatus | null,
  };
}
