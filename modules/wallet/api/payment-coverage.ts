type Json = Record<string, unknown>;
const object = (value: unknown): Json | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;

function blockTime(value: unknown): number | null {
  const block = object(value);
  const time = block?.gen_utime;
  if (
    block?.workchain !== -1 ||
    block.shard !== "8000000000000000" ||
    !Number.isSafeInteger(block.seqno) ||
    Number(block.seqno) < 1 ||
    !(
      typeof time === "number" ||
      (typeof time === "string" && /^\d+$/.test(time))
    )
  )
    return null;
  const seconds = Number(time);
  return Number.isSafeInteger(seconds) &&
    seconds > 0 &&
    seconds <= Math.floor(Date.now() / 1000)
    ? seconds
    : null;
}

/** Two independent uncached reads of TONCenter's indexed database, not v2 node head. */
export async function indexedCoverage(json: (path: string) => Promise<Json>) {
  const results = await Promise.allSettled([
    json("masterchainInfo"),
    json("blocks?workchain=-1&shard=8000000000000000&sort=desc&limit=1"),
  ]);
  const [info, blocks] = results;
  if (info?.status !== "fulfilled" || blocks?.status !== "fulfilled")
    return null;
  const first = blockTime(info.value.last);
  const rows = blocks.value.blocks;
  const second = blockTime(
    Array.isArray(rows) && rows.length === 1 ? rows[0] : null,
  );
  // Take the conservative time; larger disagreement or malformed data is unavailable.
  return first !== null && second !== null && Math.abs(first - second) <= 30
    ? Math.min(first, second)
    : null;
}
