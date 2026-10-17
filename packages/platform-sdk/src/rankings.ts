export type RankingToken = "JPEGPE" | "TON";
export type HolderEntry = {
  rank: number;
  frogName: string;
  frogId: string;
  amount: string;
  asOf: string;
  stale: boolean;
};
export type HoldersPage = {
  token: RankingToken;
  entries: HolderEntry[];
  nextCursor: string | null;
};

/** Public frog identities only; reject malformed amounts before formatting. */
export function parseHolders(value: unknown, token: RankingToken): HoldersPage {
  const page = value as HoldersPage | null;
  if (
    !page ||
    page.token !== token ||
    !Array.isArray(page.entries) ||
    !(page.nextCursor === null || typeof page.nextCursor === "string") ||
    page.entries.some(
      (row: HolderEntry | null) =>
        !row ||
        !Number.isSafeInteger(row.rank) ||
        row.rank < 1 ||
        typeof row.frogName !== "string" ||
        !row.frogName ||
        typeof row.frogId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(row.frogId) ||
        typeof row.amount !== "string" ||
        !/^\d{1,78}$/.test(row.amount) ||
        typeof row.asOf !== "string" ||
        !Number.isFinite(Date.parse(row.asOf)) ||
        typeof row.stale !== "boolean",
    )
  )
    throw new Error("unavailable");
  return {
    token,
    nextCursor: page.nextCursor,
    entries: page.entries.map(
      ({ rank, frogName, frogId, amount, asOf, stale }) => ({
        rank,
        frogName,
        frogId,
        amount,
        asOf,
        stale,
      }),
    ),
  };
}

export function rankingsAdapter(
  apiBase: string,
  authHeaders: () => { Authorization: string } | null,
) {
  return {
    async readHolders(
      token: RankingToken,
      cursor: string | null,
      signal: AbortSignal,
    ): Promise<HoldersPage> {
      const query = new URLSearchParams({ token, limit: "50" });
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${apiBase}/v1/rankings/holders?${query}`, {
        headers: authHeaders() ?? {},
        credentials: "omit",
        cache: "no-store",
        signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 409 ? "ranking_changed" : "unavailable",
        );
      return parseHolders(await response.json(), token);
    },
  };
}
