import type pg from "pg";
import { parseReport, type ClientErrorReport } from "./sanitize.ts";

export interface ClientErrorStore {
  record(report: ClientErrorReport): Promise<void>;
}

const PURGE_EVERY_MS = 60 * 60 * 1000;

/** Uses only ops-owned SQL functions; the login has no table privileges. */
export class PostgresClientErrorStore implements ClientErrorStore {
  #lastPurge = 0;
  private readonly pool: Pick<pg.Pool, "query">;
  private readonly now: () => number;
  constructor(
    pool: Pick<pg.Pool, "query">,
    now: () => number = () => Date.now(),
  ) {
    this.pool = pool;
    this.now = now;
  }
  async record(report: ClientErrorReport): Promise<void> {
    const clean = parseReport(report);
    if (!clean) return;
    await this.pool.query(
      "SELECT ops.record_client_error($1, $2, $3, $4, $5, $6::jsonb)",
      [
        clean.build,
        clean.route,
        clean.kind,
        clean.name,
        clean.message,
        JSON.stringify(clean.frames),
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
