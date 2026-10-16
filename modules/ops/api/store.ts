import type pg from "pg";
import type { ClientErrorReport } from "./sanitize.ts";

export interface ClientErrorStore {
  record(report: ClientErrorReport): Promise<void>;
}

const PURGE_EVERY_MS = 60 * 60 * 1000;

/** Uses only ops-owned SQL functions; the login has no table privileges. */
export class PostgresClientErrorStore implements ClientErrorStore {
  #lastPurge = 0;
  constructor(
    private readonly pool: Pick<pg.Pool, "query">,
    private readonly now: () => number = () => Date.now(),
  ) {}
  async record(report: ClientErrorReport): Promise<void> {
    await this.pool.query(
      "SELECT ops.record_client_error($1, $2, $3, $4, $5, $6::jsonb)",
      [
        report.build,
        report.route,
        report.kind,
        report.name,
        report.message,
        JSON.stringify(report.frames),
      ],
    );
    // No scheduler exists yet: retention runs opportunistically, at most hourly.
    const at = this.now();
    if (at - this.#lastPurge < PURGE_EVERY_MS) return;
    this.#lastPurge = at;
    try {
      await this.pool.query("SELECT ops.purge_client_errors()");
    } catch {
      this.#lastPurge = 0;
    }
  }
}
