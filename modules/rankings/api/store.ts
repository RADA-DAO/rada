import type pg from "pg";
import {
  refreshHolders,
  type HolderSource,
  type Sample,
} from "./projection.ts";
import type { HolderWallet } from "../../wallet/index.ts";
export type HolderEntry = {
  rank: number;
  frogName: string;
  frogId: string;
  amount: string;
  asOf: string;
  stale: boolean;
};
export type Page = { revision: string; entries: HolderEntry[] };
export interface RankingStore {
  page(
    token: string,
    limit: number,
    offset: number,
    revision: string | null,
  ): Promise<Page | null>;
}
export class PostgresRankingStore implements RankingStore {
  private readonly pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  async page(
    token: string,
    limit: number,
    offset: number,
    revision: string | null,
  ) {
    const result = await this.pool.query<{ page: Page | null }>(
      "SELECT rankings.holders($1, $2, $3, $4) AS page",
      [token, limit, offset, revision],
    );
    return result.rows[0]?.page ?? null;
  }
}
/** A session lock prevents overlapping refreshes across API replicas. */
export async function projectHolders(pool: pg.Pool, source: HolderSource) {
  const client = await pool.connect();
  let locked = false;
  try {
    locked =
      (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(724221, 1) AS locked",
        )
      ).rows[0]?.locked ?? false;
    if (!locked) return;
    await refreshHolders(source, {
      prune: async () => {
        await client.query("SELECT rankings.prune()");
      },
      record: async (holder: HolderWallet, sample: Sample) => {
        await client.query("SELECT rankings.record($1, $2, $3, $4, $5, $6)", [
          holder.subject_id,
          holder.frog_id,
          holder.link_version,
          sample.token,
          sample.amount,
          sample.asOf,
        ]);
      },
    });
  } finally {
    // A failed unlock discards the connection, which ends its session and
    // with it the advisory lock; the original error, if any, still propagates.
    let unlocked = true;
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(724221, 1)");
    } catch {
      unlocked = false;
    }
    client.release(!unlocked);
  }
}
export function startHolderScheduler(
  pool: pg.Pool,
  source: HolderSource,
  log: (line: string) => void,
) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await projectHolders(pool, source);
    } catch {
      log('{"event":"holders_refresh_failed"}');
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(() => {
    void run();
  }, 3_600_000);
}
