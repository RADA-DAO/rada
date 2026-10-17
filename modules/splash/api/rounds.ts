import type pg from "pg";

type Queryable = Pick<pg.PoolClient, "query">;

/** A person's public profile: their selected frog, only while they still own it. */
export type PublicProfile = {
  frogId: string;
  username: string;
  backgroundColor: string | null;
  accentColor: string | null;
} | null;
export type RoundLot = {
  submissionId: string;
  submittedAt: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
  author: PublicProfile;
  /** Smallest JPEGPE units as a decimal string; null without bids. */
  topAmount: string | null;
  bidderCount: number;
  leader: PublicProfile;
};
export type CurrentRound = {
  roundId: number;
  startsAt: string;
  endsAt: string;
  acceptingBids: boolean;
  lots: RoundLot[];
};
export type BidRefusal =
  | "rate_limited"
  | "invalid_amount"
  | "invalid_name"
  | "name_taken"
  | "not_on_auction"
  | "round_closed"
  | "self_bid"
  | "bid_too_low"
  | "bid_unchanged";
export type BidResult =
  | {
      status: "placed";
      bidId: string;
      roundId: number;
      amount: string;
      username: string;
      placedAt: string;
      /** Another frog of this round has a bid proposing the same name. */
      nameContested: boolean;
    }
  | { status: BidRefusal };
/** `reserved`: the name is held for the winner until the paid claim makes it permanent. */
export type NameOutcome = "reserved" | "conflict" | "unavailable";
export type OwnBid = {
  roundId: number;
  submissionId: string;
  amount: string;
  username: string;
  placedAt: string;
  roundEndsAt: string;
  status: "active" | "won" | "lost";
  grantedUsername: string | null;
  nameOutcome: NameOutcome | null;
  claimDeadline: string | null;
};
export type LotResult = {
  submissionId: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
  bidderCount: number;
  amount: string | null;
  username: string | null;
  nameOutcome: NameOutcome | null;
  claimDeadline: string | null;
  winner: PublicProfile;
};
export type RoundResults = {
  roundId: number;
  startsAt: string;
  endsAt: string;
  closedAt: string;
  lots: LotResult[];
};
/** What the claim change needs about a won frog. */
export type PendingClaim = {
  roundId: number;
  winnerSubjectId: string;
  amount: string;
  username: string | null;
  nameOutcome: NameOutcome;
  claimDeadline: string;
};

export type NameStatus = "available" | "taken" | "invalid";

export interface RoundStore {
  currentRound(): Promise<CurrentRound | null>;
  placeBid(
    telegramId: string,
    submissionId: string,
    amount: string,
    username: string,
  ): Promise<BidResult>;
  myBids(telegramId: string): Promise<OwnBid[]>;
  roundResults(roundId: number): Promise<RoundResults | null>;
  /** Whether a proposed permanent name is free under JPEGPE's rule right now. */
  nameStatus(name: string): Promise<NameStatus>;
  /** The round job: closes due rounds and opens the current one. */
  advanceRounds(): Promise<number>;
}

type Row = Record<string, unknown>;
const iso = (value: unknown) => (value as Date).toISOString();
const isoOrNull = (value: unknown) => (value ? iso(value) : null);
function profile(row: Row, prefix: string): PublicProfile {
  const frogId = row[`${prefix}_frog_id`] as string | null;
  const username = row[`${prefix}_username`] as string | null;
  if (!frogId || !username) return null;
  return {
    frogId,
    username,
    backgroundColor: row[`${prefix}_background_color`] as string | null,
    accentColor: row[`${prefix}_accent_color`] as string | null,
  };
}

export async function queryCurrentRound(
  client: Queryable,
): Promise<CurrentRound | null> {
  const { rows } = await client.query<Row>(
    "SELECT * FROM splash.current_round()",
  );
  const first = rows[0];
  if (!first) return null;
  return {
    roundId: Number(first.round_id),
    startsAt: iso(first.starts_at),
    endsAt: iso(first.ends_at),
    acceptingBids: first.accepting_bids === true,
    lots: rows
      .filter((row) => row.submission_id)
      .map((row) => ({
        submissionId: row.submission_id as string,
        submittedAt: iso(row.submitted_at),
        width: row.width as number,
        height: row.height as number,
        backgroundRemoved: row.background_removed as boolean,
        author: profile(row, "author"),
        topAmount: (row.top_amount as string | null) ?? null,
        bidderCount: row.bidder_count as number,
        leader: profile(row, "leader"),
      })),
  };
}

export async function insertBid(
  client: Queryable,
  submissionId: string,
  amount: string,
  username: string,
): Promise<BidResult> {
  const { rows } = await client.query<Row>(
    "SELECT * FROM splash.place_bid($1::uuid, $2::numeric, $3::text)",
    [submissionId, amount, username],
  );
  const row = rows[0];
  if (!row) throw new Error("place_bid returned no row");
  if (row.status !== "placed") return { status: row.status as BidRefusal };
  return {
    status: "placed",
    bidId: String(row.bid_id),
    roundId: Number(row.round_id),
    amount: row.amount as string,
    username: row.username as string,
    placedAt: iso(row.placed_at),
    nameContested: row.name_contested === true,
  };
}

export async function queryOwnBids(client: Queryable): Promise<OwnBid[]> {
  const { rows } = await client.query<Row>("SELECT * FROM splash.my_bids()");
  return rows.map((row) => ({
    roundId: Number(row.round_id),
    submissionId: row.submission_id as string,
    amount: row.amount as string,
    username: row.username as string,
    placedAt: iso(row.placed_at),
    roundEndsAt: iso(row.round_ends_at),
    status: row.status as OwnBid["status"],
    grantedUsername: (row.granted_username as string | null) ?? null,
    nameOutcome: (row.name_outcome as NameOutcome | null) ?? null,
    claimDeadline: isoOrNull(row.claim_deadline),
  }));
}

export async function queryRoundResults(
  client: Queryable,
  roundId: number,
): Promise<RoundResults | null> {
  const { rows } = await client.query<Row>(
    "SELECT * FROM splash.round_results($1::bigint)",
    [String(roundId)],
  );
  const first = rows[0];
  if (!first) return null;
  return {
    roundId: Number(first.round_id),
    startsAt: iso(first.starts_at),
    endsAt: iso(first.ends_at),
    closedAt: iso(first.closed_at),
    lots: rows
      .filter((row) => row.submission_id)
      .map((row) => ({
        submissionId: row.submission_id as string,
        width: row.width as number,
        height: row.height as number,
        backgroundRemoved: row.background_removed as boolean,
        bidderCount: row.bidder_count as number,
        amount: (row.amount as string | null) ?? null,
        username: (row.username as string | null) ?? null,
        nameOutcome: (row.name_outcome as NameOutcome | null) ?? null,
        claimDeadline: isoOrNull(row.claim_deadline),
        winner: profile(row, "winner"),
      })),
  };
}

export async function queryNameStatus(
  client: Queryable,
  name: string,
): Promise<NameStatus> {
  const result = await client.query<{ status: NameStatus }>(
    "SELECT splash.name_status($1) AS status",
    [name],
  );
  const status = result.rows[0]?.status;
  return status === "available" || status === "taken" ? status : "invalid";
}

export async function runAdvanceRounds(client: Queryable): Promise<number> {
  const { rows } = await client.query<{ closed: number }>(
    "SELECT splash.advance_rounds() AS closed",
  );
  return rows[0]?.closed ?? 0;
}

/**
 * For the claim change: the pending win of a frog (winner, amount, granted name
 * or null when it must be chosen at claim, deadline), or null.
 */
export async function readPendingClaim(
  client: Queryable,
  submissionId: string,
): Promise<PendingClaim | null> {
  const { rows } = await client.query<Row>(
    "SELECT * FROM splash.pending_claim($1::uuid)",
    [submissionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    roundId: Number(row.round_id),
    winnerSubjectId: row.winner_subject_id as string,
    amount: row.amount as string,
    username: (row.username as string | null) ?? null,
    nameOutcome: row.name_outcome as NameOutcome,
    claimDeadline: iso(row.claim_deadline),
  };
}

/**
 * Runs the round job now and then every `everyMs`, never overlapping itself:
 * close due rounds, then settle claims (complete paid ones, burn expired ones).
 * Both SQL steps are idempotent and serialised, so several API processes are
 * safe. Failures log one line with the error class only.
 */
export function startRoundScheduler(
  store: Pick<RoundStore, "advanceRounds">,
  everyMs: number = 60_000,
  log: (line: string) => void = console.log,
  claims?: { settle(): Promise<void> },
): () => void {
  let running = false;
  const step = async (event: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (error) {
      log(
        JSON.stringify({
          event,
          errorClass: error instanceof Error ? error.name : "unknown",
        }),
      );
    }
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await step("splash_round_job_failed", () => store.advanceRounds());
      if (claims) await step("splash_claim_job_failed", () => claims.settle());
    } finally {
      running = false;
    }
  };
  void tick();
  const id = setInterval(() => void tick(), everyMs);
  return () => clearInterval(id);
}
