import { randomUUID } from "node:crypto";
import pg from "pg";
import { Address } from "@ton/ton";
import { resolveTelegramSubject } from "../../identity/index.ts";
import {
  PaymentChain,
  type PaymentRecord,
  type SignRequest,
} from "./payment-chain.ts";
import type { FeeEstimate } from "./payment-fee.ts";

export type PaymentInput = {
  appId: string;
  idempotencyKey: string;
  token: "TON" | "JPEGPE";
  amount: string;
  recipient: string;
  sender: string;
  purpose: string;
};

export type PaymentStatus = "prepared" | "unknown" | "paid" | "cancelled";
export type PaymentView = PaymentRecord & {
  status: PaymentStatus;
  network: "-239";
  gasBudget: string | null;
  feeEstimate: FeeEstimate | null;
  /** Recipient transaction time on chain, once paid. */
  paidOnChainAt: string | null;
  scanStatus?: "confirmed" | "confirmed-absent" | "incomplete";
};
type Row = {
  intent_id: string;
  app_id: string;
  idempotency_key: string;
  token: "TON" | "JPEGPE";
  amount: string;
  recipient: string;
  sender: string;
  purpose: string;
  created_at: Date;
  status: PaymentStatus;
  receipt_hash: string | null;
  platform: boolean;
  sign_before: Date | null;
  paid_on_chain_at: Date | null;
};
// Stable names, so platform modules can recognise these without importing classes.
export class PaymentConflict extends Error {
  override name = "PaymentConflict";
}
export class PaymentDenied extends Error {
  override name = "PaymentDenied";
}
/** The intent's signing window (a platform deadline) has closed. */
export class PaymentExpired extends Error {
  override name = "PaymentExpired";
}
/** Last moment a platform intent can still be handed to the wallet for signing. */
const SIGN_MARGIN_SECONDS = 30;

const raw = (address: string) =>
  Address.parse(address).toRawString().toLowerCase();
function view(row: Row): PaymentView {
  return {
    intentId: row.intent_id,
    token: row.token,
    amount: row.amount,
    recipient: row.recipient,
    sender: row.sender,
    purpose: row.purpose,
    createdAt: row.created_at.toISOString(),
    status: row.status,
    network: "-239",
    feeEstimate: null,
    gasBudget: row.token === "JPEGPE" ? "100000000" : null,
    paidOnChainAt: row.paid_on_chain_at?.toISOString() ?? null,
  };
}
export class PostgresPaymentStore {
  constructor(
    private auth: pg.Pool,
    private service: pg.Pool,
    private chain: PaymentChain = new PaymentChain(),
  ) {}
  private async transaction<T>(
    telegramId: string,
    run: (db: pg.PoolClient) => Promise<T>,
  ) {
    return await this.asSubject(
      await resolveTelegramSubject(this.auth, telegramId),
      run,
    );
  }
  private async asSubject<T>(
    subject: string,
    run: (db: pg.PoolClient) => Promise<T>,
  ) {
    const db = await this.service.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('rada.subject_id', $1, true)", [
        subject,
      ]);
      const value = await run(db);
      await db.query("COMMIT");
      return value;
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  }
  /** Community apps need a released money.transfer grant; platform intents do not. */
  private async allowed(
    db: pg.PoolClient,
    appId: string,
    sender: string,
    platform = false,
  ) {
    const result = await db.query<{ released: boolean; linked: boolean }>(
      `SELECT $3::boolean OR apps.money_transfer_released($1) AS released,
        EXISTS(SELECT 1 FROM identity.own_wallet() WHERE address_raw = $2) AS linked`,
      [appId, sender, platform],
    );
    if (!result.rows[0]?.released || !result.rows[0]?.linked)
      throw new PaymentDenied();
  }
  async prepare(telegramId: string, input: PaymentInput): Promise<PaymentView> {
    return await this.withFee(
      await this.transaction(telegramId, (db) => this.insert(db, input, null)),
    );
  }
  /**
   * Server-side only: an intent whose terms a platform module fixed (amount,
   * recipient, purpose) for a verified subject. Signing closes at `signBefore`.
   */
  async preparePlatform(
    subjectId: string,
    input: PaymentInput,
    signBefore: Date,
  ): Promise<PaymentView> {
    return await this.withFee(
      await this.asSubject(subjectId, (db) =>
        this.insert(db, input, signBefore),
      ),
    );
  }
  async reconcileAs(
    subjectId: string,
    appId: string,
    intentId: string,
    scanUntil?: number,
  ) {
    return await this.reconcileFor(
      (run) => this.asSubject(subjectId, run),
      appId,
      intentId,
      scanUntil,
    );
  }
  async cancelAs(subjectId: string, appId: string, intentId: string) {
    return await this.asSubject(subjectId, (db) =>
      this.cancelIn(db, appId, intentId),
    );
  }
  private async withFee(payment: PaymentView): Promise<PaymentView> {
    return {
      ...payment,
      feeEstimate:
        payment.status === "prepared"
          ? await this.chain.estimateFee(payment)
          : null,
    };
  }
  private async insert(
    db: pg.PoolClient,
    input: PaymentInput,
    signBefore: Date | null,
  ): Promise<PaymentView> {
    const sender = raw(input.sender),
      recipient = raw(input.recipient),
      platform = signBefore !== null;
    await this.allowed(db, input.appId, sender, platform);
    await db.query(
      `INSERT INTO wallet.payment_intents
          (intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose,platform,sign_before)
         VALUES ($1,identity.current_subject(),$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (subject_id,app_id,idempotency_key) DO NOTHING`,
      [
        randomUUID(),
        input.appId,
        input.idempotencyKey,
        input.token,
        input.amount,
        recipient,
        sender,
        input.purpose,
        platform,
        signBefore,
      ],
    );
    const result = await db.query<Row>(
      `SELECT * FROM wallet.payment_intents WHERE subject_id=identity.current_subject()
         AND app_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [input.appId, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error("unavailable");
    if (
      row.token !== input.token ||
      row.amount !== input.amount ||
      row.recipient !== recipient ||
      row.sender !== sender ||
      row.purpose !== input.purpose ||
      row.platform !== platform ||
      row.sign_before?.getTime() !== signBefore?.getTime()
    )
      throw new PaymentConflict();
    return view(row);
  }
  async claim(
    telegramId: string,
    appId: string,
    intentId: string,
  ): Promise<{ payment: PaymentView; signRequest: SignRequest | null }> {
    return await this.transaction(telegramId, async (db) => {
      const result = await db.query<Row>(
        `SELECT * FROM wallet.payment_intents WHERE intent_id=$1 AND app_id=$2
         AND subject_id=identity.current_subject() FOR UPDATE`,
        [intentId, appId],
      );
      const row = result.rows[0];
      if (!row) throw new PaymentDenied();
      if (row.status !== "prepared")
        return { payment: view(row), signRequest: null };
      await this.allowed(db, row.app_id, row.sender, row.platform);
      const notAfter = row.sign_before
        ? Math.floor(row.sign_before.getTime() / 1000)
        : undefined;
      if (
        notAfter !== undefined &&
        notAfter - Math.floor(Date.now() / 1000) < SIGN_MARGIN_SECONDS
      )
        throw new PaymentExpired();
      const signRequest = await this.chain.signRequest(view(row), notAfter);
      await db.query(
        `UPDATE wallet.payment_intents SET status='unknown',send_started_at=now()
         WHERE intent_id=$1`,
        [intentId],
      );
      return { payment: { ...view(row), status: "unknown" }, signRequest };
    });
  }
  async cancel(
    telegramId: string,
    appId: string,
    intentId: string,
  ): Promise<PaymentView> {
    return await this.transaction(telegramId, (db) =>
      this.cancelIn(db, appId, intentId),
    );
  }
  private async cancelIn(
    db: pg.PoolClient,
    appId: string,
    intentId: string,
  ): Promise<PaymentView> {
    const result = await db.query<Row>(
      `UPDATE wallet.payment_intents SET status='cancelled'
         WHERE intent_id=$1 AND app_id=$2 AND subject_id=identity.current_subject() AND status='prepared'
         RETURNING *`,
      [intentId, appId],
    );
    if (result.rows[0]) return view(result.rows[0]);
    const existing = await db.query<Row>(
      `SELECT * FROM wallet.payment_intents WHERE intent_id=$1 AND app_id=$2
         AND subject_id=identity.current_subject()`,
      [intentId, appId],
    );
    if (!existing.rows[0]) throw new PaymentDenied();
    return view(existing.rows[0]);
  }
  async reconcile(
    telegramId: string,
    appId: string,
    intentId: string,
  ): Promise<PaymentView> {
    return await this.reconcileFor(
      (run) => this.transaction(telegramId, run),
      appId,
      intentId,
    );
  }
  private async reconcileFor(
    within: <T>(run: (db: pg.PoolClient) => Promise<T>) => Promise<T>,
    appId: string,
    intentId: string,
    scanUntil?: number,
  ): Promise<PaymentView> {
    const record = await within(async (db) => {
      const result = await db.query<Row>(
        `SELECT * FROM wallet.payment_intents WHERE intent_id=$1 AND app_id=$2
         AND subject_id=identity.current_subject()`,
        [intentId, appId],
      );
      if (!result.rows[0]) throw new PaymentDenied();
      return result.rows[0];
    });
    if (record.status !== "unknown") return view(record);
    const receipt = await this.chain.confirmation(view(record), scanUntil);
    if (receipt.status !== "confirmed")
      return { ...view(record), scanStatus: receipt.status };
    return await within(async (db) => {
      const result = await db.query<Row>(
        `UPDATE wallet.payment_intents
         SET status='paid',receipt_hash=$2,paid_on_chain_at=to_timestamp($4)
         WHERE intent_id=$1 AND app_id=$3 AND subject_id=identity.current_subject() AND status='unknown'
         RETURNING *`,
        [intentId, receipt.hash, appId, receipt.onChainAt],
      );
      if (result.rows[0]) return view(result.rows[0]);
      const existing = await db.query<Row>(
        `SELECT * FROM wallet.payment_intents WHERE intent_id=$1 AND app_id=$2 AND subject_id=identity.current_subject()`,
        [intentId, appId],
      );
      if (!existing.rows[0]) throw new PaymentDenied();
      return view(existing.rows[0]);
    });
  }
}
