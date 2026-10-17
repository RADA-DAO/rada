import { Address } from "@ton/ton";
import { createWalletBalanceReader, JPEGPE_JETTON_MASTER } from "./balances.ts";
import { indexedCoverage } from "./payment-coverage.ts";
type Row = Record<string, unknown>;
const object = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
export function treasuryAddress(value: unknown): string | null {
  try {
    return typeof value === "string"
      ? Address.parse(value).toRawString().toLowerCase()
      : null;
  } catch {
    return null;
  }
}
function hash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return bytes.length === 32
      ? Array.from(bytes, (c) =>
          c.charCodeAt(0).toString(16).padStart(2, "0"),
        ).join("")
      : null;
  } catch {
    return null;
  }
}
export type TreasuryMovement = {
  key: string;
  hash: string;
  at: string;
  direction: "in" | "out";
  token: "TON" | "JPEGPE";
  amount: string;
  counterparty: string;
};
export type TreasurySample = {
  balances?: { TON: string; JPEGPE: string };
  balanceAt?: string;
  signers?: string[];
  movements?: TreasuryMovement[];
  indexedThrough?: string | null;
  incomplete: boolean;
};
/** Provider metadata, comments and address books never enter the projection. */
export function normalizeTreasuryRows(
  rows: unknown[],
  address: string,
  jetton: boolean,
): TreasuryMovement[] {
  const output: TreasuryMovement[] = [];
  for (const raw of rows) {
    const tx = object(raw),
      id = hash(jetton ? tx.transaction_hash : tx.hash);
    const seconds = jetton ? tx.transaction_now : tx.now;
    if (
      !id ||
      !Number.isSafeInteger(seconds) ||
      Number(seconds) <= 0 ||
      Number(seconds) > Date.now() / 1000
    )
      continue;
    if (
      jetton
        ? tx.transaction_aborted !== false ||
          treasuryAddress(tx.jetton_master) !== JPEGPE_JETTON_MASTER
        : object(tx.description).aborted !== false ||
          tx.emulated === true ||
          treasuryAddress(tx.account) !== address
    )
      continue;
    const messages = jetton
      ? [tx]
      : [tx.in_msg, ...(Array.isArray(tx.out_msgs) ? tx.out_msgs : [])];
    messages.forEach((rawMessage, index) => {
      const m = object(rawMessage),
        from = treasuryAddress(m.source),
        to = treasuryAddress(m.destination);
      const amount = jetton ? m.amount : m.value;
      if (
        !from ||
        !to ||
        from === to ||
        (from !== address && to !== address) ||
        m.bounced === true ||
        typeof amount !== "string" ||
        !/^\d{1,80}$/.test(amount) ||
        BigInt(amount) === 0n
      )
        return;
      output.push({
        key: `${id}:${jetton ? "JPEGPE" : "TON"}:${index}`,
        hash: id,
        at: new Date(Number(seconds) * 1000).toISOString(),
        direction: to === address ? "in" : "out",
        token: jetton ? "JPEGPE" : "TON",
        amount,
        counterparty: to === address ? from : to,
      });
    });
  }
  return output;
}
/** Fixed GET-only endpoints. Bounded recent history is never payment reconciliation. */
export function createTreasuryChainReader(
  send: typeof fetch = fetch,
  pause = () => new Promise<void>((r) => setTimeout(r, 1100)),
) {
  const balances = createWalletBalanceReader(send);
  let queue = Promise.resolve();
  const json = (path: string): Promise<Row> => {
    const task = queue.then(async () => {
      await pause();
      const response = await send(`https://toncenter.com/api/v3/${path}`, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("chain_unavailable");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("chain_unavailable");
      let text = "",
        size = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 2_000_000) {
            await reader.cancel();
            throw new Error("chain_too_large");
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
      return object(JSON.parse(text + decoder.decode()));
    });
    queue = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  return async (address: string): Promise<TreasurySample> => {
    const canonical = treasuryAddress(address);
    if (!canonical) throw new Error("invalid_address");
    const sample: TreasurySample = { incomplete: true };
    const balance = await balances(canonical);
    if (balance.gram && balance.jpegpe && balance.balancesUpdatedAt) {
      sample.balances = { TON: balance.gram.raw, JPEGPE: balance.jpegpe.raw };
      sample.balanceAt = balance.balancesUpdatedAt;
    }
    try {
      const data = await json(
        `multisig/wallets?${new URLSearchParams({ address: canonical, include_orders: "false" })}`,
      );
      const row = Array.isArray(data.multisigs)
        ? data.multisigs
            .map(object)
            .find((r) => treasuryAddress(r.address) === canonical)
        : undefined;
      if (row && Array.isArray(row.signers) && row.signers.length <= 256) {
        const signers = row.signers.map(treasuryAddress);
        if (signers.every((s): s is string => s !== null))
          sample.signers = signers;
      }
    } catch {
      /* Retain the last signer sample. */
    }
    const watermark = await indexedCoverage(json);
    sample.indexedThrough = watermark
      ? new Date(watermark * 1000).toISOString()
      : null;
    const now = Math.floor(Date.now() / 1000);
    // Bound the advertised window by independently observed index coverage.
    const end = Math.min(now, watermark ?? now),
      start = end - 30 * 86400;
    let complete = watermark !== null && watermark >= now - 600;
    const movements: TreasuryMovement[] = [];
    try {
      for (const jetton of [false, true]) {
        let exhausted = false;
        for (let page = 0; page < 3; page++) {
          const query = new URLSearchParams({
            [jetton ? "owner_address" : "account"]: canonical,
            start_utime: String(start),
            end_utime: String(end),
            limit: "100",
            offset: String(page * 100),
            sort: "desc",
          });
          if (jetton) query.set("jetton_master", JPEGPE_JETTON_MASTER);
          const data = await json(
            `${jetton ? "jetton/transfers" : "transactions"}?${query}`,
          );
          const rows = data[jetton ? "jetton_transfers" : "transactions"];
          if (!Array.isArray(rows) || rows.length > 100)
            throw new Error("invalid_chain_page");
          movements.push(...normalizeTreasuryRows(rows, canonical, jetton));
          if (rows.length < 100) {
            exhausted = true;
            break;
          }
        }
        complete &&= exhausted;
      }
      sample.movements = movements.sort(
        (a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key),
      );
      sample.incomplete = !complete;
    } catch {
      /* A partial read cannot refresh history freshness. */
    }
    return sample;
  };
}
