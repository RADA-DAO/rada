import type pg from "pg";
import { resolveTelegramSubject } from "../../identity/index.ts";
export interface Preference {
  category: "splash" | "governance";
  enabled: boolean;
  locale: "en" | "uk";
  quiet_start: number | null;
  quiet_end: number | null;
}
export class NotificationStore {
  private auth: pg.Pool;
  private pool: pg.Pool;
  constructor(auth: pg.Pool, pool: pg.Pool) {
    this.auth = auth;
    this.pool = pool;
  }
  async own(
    actor: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<unknown> {
    const subject = await resolveTelegramSubject(this.auth, actor);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      const result = await client.query<{ result: unknown }>(sql, values);
      await client.query("COMMIT");
      return result.rows[0]?.result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  read(actor: string) {
    return this.own(actor, "SELECT notifications.preferences() AS result");
  }
  save(actor: string, p: Preference) {
    return this.own(
      actor,
      "SELECT notifications.set_preference($1,$2,$3,$4,$5) AS result",
      [p.category, p.enabled, p.locale, p.quiet_start, p.quiet_end],
    );
  }
  test(actor: string, category: string) {
    return this.own(actor, "SELECT notifications.test_message($1) AS result", [
      category,
    ]);
  }
}
