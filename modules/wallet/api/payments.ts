import { randomUUID } from "node:crypto";
import pg from "pg";
import { Address } from "@ton/ton";
import { resolveTelegramSubject } from "../../identity/index.ts";
import {
  PaymentChain,
  type PaymentRecord,
  type SignRequest,
} from "./payment-chain.ts";

export type PaymentInput = {
  appId: string;
  idempotencyKey: string;
  token: "TON" | "JPEGPE";
  amount: string;
  recipient: string;
  sender: string;
  purpose: string;
};
import type { FeeEstimate } from "./payment-fee.ts";

export type PaymentStatus = "prepared" | "unknown" | "paid" | "cancelled";
export type PaymentView = PaymentRecord & {
  status: PaymentStatus;
  network: "-239";
  gasBudget: string | null;
  feeEstimate: FeeEstimate | null;
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
};
export class PaymentConflict extends Error {}
export class PaymentDenied extends Error {}

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
    const subject = await resolveTelegramSubject(this.auth, telegramId);
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
  private async allowed(db: pg.PoolClient, appId: string, sender: string) {
    const result = await db.query<{ released: boolean; linked: boolean }>(
      `SELECT apps.money_transfer_released($1) AS released,
        EXISTS(SELECT 1 FROM identity.own_wallet() WHERE address_raw = $2) AS linked`,
      [appId, sender],
    );
    if (!result.rows[0]?.released || !result.rows[0]?.linked)
      throw new PaymentDenied();
  }
  async prepare(telegramId: string, input: PaymentInput): Promise<PaymentView> {
    const sender = raw(input.sender),
      recipient = raw(input.recipient);
    const payment = await this.transaction(telegramId, async (db) => {
      await this.allowed(db, input.appId, sender);
      await db.query(
        `INSERT INTO wallet.payment_intents
          (intent_id,subject_id,app_id,idempotency_key,token,amount,recipient,sender,purpose)
         VALUES ($1,identity.current_subject(),$2,$3,$4,$5,$6,$7,$8)
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
        row.purpose !== input.purpose
      )
        throw new PaymentConflict();
      return view(row);
    });
    return {
      ...payment,
      feeEstimate:
        payment.status === "prepared"
          ? await this.chain.estimateFee(payment)
          : null,
    };
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
      await this.allowed(db, row.app_id, row.sender);
      const signRequest = await this.chain.signRequest(view(row));
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
    return await this.transaction(telegramId, async (db) => {
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
    });
  }
  async reconcile(
    telegramId: string,
    appId: string,
    intentId: string,
  ): Promise<PaymentView> {
    const record = await this.transaction(telegramId, async (db) => {
      const result = await db.query<Row>(
        `SELECT * FROM wallet.payment_intents WHERE intent_id=$1 AND app_id=$2
         AND subject_id=identity.current_subject()`,
        [intentId, appId],
      );
      if (!result.rows[0]) throw new PaymentDenied();
      return result.rows[0];
    });
    if (record.status !== "unknown") return view(record);
    const receipt = await this.chain.receipt(view(record));
    if (!receipt) return view(record);
    return await this.transaction(telegramId, async (db) => {
      const result = await db.query<Row>(
        `UPDATE wallet.payment_intents SET status='paid',receipt_hash=$2
         WHERE intent_id=$1 AND app_id=$3 AND subject_id=identity.current_subject() AND status='unknown'
         RETURNING *`,
        [intentId, receipt, appId],
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
