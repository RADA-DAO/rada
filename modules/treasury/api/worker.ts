import type pg from "pg";
import {
  createTreasuryChainReader,
  type TreasurySample,
} from "../../wallet/index.ts";
export type TreasuryReader = (address: string) => Promise<TreasurySample>;
export async function projectTreasury(pool: pg.Pool, read: TreasuryReader) {
  const client = await pool.connect();
  let locked = false,
    broken = false;
  try {
    locked =
      (
        await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(724223,2) AS locked",
        )
      ).rows[0]?.locked ?? false;
    if (!locked) return;
    const wallets = (
      await client.query<{ address: string; version: string }>(
        "SELECT * FROM treasury.wallets()",
      )
    ).rows;
    for (const wallet of wallets) {
      let sample: TreasurySample | null = null;
      try {
        sample = await read(wallet.address);
      } catch {
        /* Persist a failed attempt without replacing samples. */
      }
      await client.query("SELECT treasury.record($1,$2,$3::jsonb)", [
        wallet.address,
        wallet.version,
        sample === null ? null : JSON.stringify(sample),
      ]);
    }
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock(724223,2)");
    } catch {
      broken = true;
    }
    client.release(broken);
  }
}
export function treasuryWorkerEnabled(mode: string, flag: string | undefined) {
  return mode !== "synthetic" && flag === "true";
}
export function startTreasuryScheduler(
  pool: pg.Pool,
  log: (line: string) => void,
  read: TreasuryReader = createTreasuryChainReader(),
) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await projectTreasury(pool, read);
    } catch {
      log('{"event":"treasury_refresh_failed"}');
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(() => {
    void run();
  }, 300_000);
}
