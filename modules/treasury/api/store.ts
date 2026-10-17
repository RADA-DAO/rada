import type pg from "pg";
import { resolveTelegramSubject } from "../../identity/index.ts";
export interface TreasuryStore {
  overview(): Promise<unknown>;
  transactions(
    before: string | null,
    direction: string | null,
    token: string | null,
  ): Promise<Record<string, unknown>[]>;
  history(before: string | null): Promise<Record<string, unknown>[]>;
  configure(
    actor: string,
    address: string,
    enabled: boolean,
    reason: string,
  ): Promise<void>;
}
export class PostgresTreasuryStore implements TreasuryStore {
  private auth: pg.Pool;
  private pool: pg.Pool;
  constructor(auth: pg.Pool, pool: pg.Pool) {
    this.auth = auth;
    this.pool = pool;
  }
  private async query(sql: string, values: unknown[] = []) {
    return (await this.pool.query<{ result: unknown }>(sql, values)).rows[0]
      ?.result;
  }
  overview() {
    return this.query("SELECT treasury.overview() AS result");
  }
  async transactions(
    before: string | null,
    direction: string | null,
    token: string | null,
  ) {
    return (await this.query(
      "SELECT treasury.transactions($1,$2,$3) AS result",
      [before, direction, token],
    )) as Record<string, unknown>[];
  }
  async history(before: string | null) {
    return (await this.query("SELECT treasury.history($1) AS result", [
      before,
    ])) as Record<string, unknown>[];
  }
  async configure(
    actor: string,
    address: string,
    enabled: boolean,
    reason: string,
  ) {
    const subject = await resolveTelegramSubject(this.auth, actor),
      client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      await client.query("SELECT treasury.configure($1,$2,$3)", [
        address,
        enabled,
        reason,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
