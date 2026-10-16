import type pg from "pg";
import type { AlertStore, ClientErrorSummary } from "./digest.ts";

/** Uses only ops-owned SQL functions; the login has no table privileges. */
export class PostgresAlertStore implements AlertStore {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}

  async summary(): Promise<ClientErrorSummary> {
    const mark = await this.pool.query("SELECT ops.alert_watermark() AS after");
    const after = String(mark.rows[0]?.after ?? "0");
    const result = await this.pool.query(
      "SELECT kind, name, route, total, grand_total, last_id FROM ops.client_error_summary($1::bigint, 10)",
      [after],
    );
    const first = result.rows[0];
    return {
      groups: result.rows.map((row) => ({
        label: `${row.kind}/${row.name}/${row.route}`,
        total: Number(row.total),
      })),
      total: first ? Number(first.grand_total) : 0,
      lastId: first ? Number(first.last_id) : 0,
    };
  }

  async advance(lastId: number): Promise<void> {
    await this.pool.query("SELECT ops.advance_alert_watermark($1::bigint)", [
      String(lastId),
    ]);
  }
}
