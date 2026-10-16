import type { Hono } from "hono";
import type { BidRefusal, PublicProfile, RoundStore } from "./rounds.ts";

export type Authenticated = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Smallest JPEGPE units: a positive integer, as a decimal string (or safe integer). */
const AMOUNT = /^[1-9][0-9]{0,77}$/;
const ROUND_ID = /^[1-9][0-9]{0,15}$/;
const MAX_BID_BODY = 1024;

const imagePath = (id: string) => `/v1/splash/submissions/${id}/image`;
const profile = (value: PublicProfile) =>
  value && {
    frog_id: value.frogId,
    username: value.username,
    background_color: value.backgroundColor,
    accent_color: value.accentColor,
  };
const refusalStatus: Record<BidRefusal, 400 | 403 | 404 | 409> = {
  invalid_amount: 400,
  invalid_name: 400,
  not_on_auction: 404,
  self_bid: 403,
  name_taken: 409,
  bid_too_low: 409,
  bid_unchanged: 409,
  round_closed: 409,
};

type BidInput = { submissionId: string; amount: string; username: string };
/** Returns the validated bid, or the error code for a 400 response. */
export function parseBid(text: string): BidInput | "invalid_body" | BidRefusal {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return "invalid_body";
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "invalid_body";
  const { submission_id, amount, name } = body as Record<string, unknown>;
  if (typeof submission_id !== "string" || !UUID.test(submission_id))
    return "invalid_body";
  const digits =
    typeof amount === "number" && Number.isSafeInteger(amount)
      ? String(amount)
      : amount;
  if (typeof digits !== "string" || !AMOUNT.test(digits))
    return "invalid_amount";
  // The naming rule itself belongs to JPEGPE and is checked in SQL.
  if (typeof name !== "string" || name.length < 1 || name.length > 32)
    return "invalid_name";
  return {
    submissionId: submission_id.toLowerCase(),
    amount: digits,
    username: name,
  };
}

export function registerRoundRoutes(
  app: Hono,
  store: RoundStore,
  authenticated: Authenticated,
) {
  app.get("/v1/splash/round", async (c) => {
    const round = await store.currentRound();
    return c.json({
      round: round && {
        round_id: round.roundId,
        starts_at: round.startsAt,
        ends_at: round.endsAt,
        accepting_bids: round.acceptingBids,
        frogs: round.lots.map((lot) => ({
          submission_id: lot.submissionId,
          submitted_at: lot.submittedAt,
          width: lot.width,
          height: lot.height,
          background_removed: lot.backgroundRemoved,
          image_path: imagePath(lot.submissionId),
          author: profile(lot.author),
          top_amount: lot.topAmount,
          bidder_count: lot.bidderCount,
          leader: profile(lot.leader),
        })),
      },
    });
  });
  app.post("/v1/splash/bids", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BID_BODY)
      return c.json({ error: "too_large" }, 413);
    const text = await c.req.text();
    if (text.length > MAX_BID_BODY) return c.json({ error: "too_large" }, 413);
    const input = parseBid(text);
    if (typeof input === "string") return c.json({ error: input }, 400);
    const result = await store.placeBid(
      id,
      input.submissionId,
      input.amount,
      input.username,
    );
    if (result.status !== "placed")
      return c.json({ error: result.status }, refusalStatus[result.status]);
    return c.json(
      {
        bid_id: result.bidId,
        round_id: result.roundId,
        submission_id: input.submissionId,
        amount: result.amount,
        name: result.username,
        placed_at: result.placedAt,
        name_contested: result.nameContested,
      },
      201,
    );
  });
  app.get("/v1/splash/bids/mine", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const bids = await store.myBids(id);
    return c.json({
      bids: bids.map((bid) => ({
        round_id: bid.roundId,
        submission_id: bid.submissionId,
        amount: bid.amount,
        name: bid.username,
        placed_at: bid.placedAt,
        round_ends_at: bid.roundEndsAt,
        status: bid.status,
        granted_name: bid.grantedUsername,
        name_outcome: bid.nameOutcome,
        claim_deadline: bid.claimDeadline,
      })),
    });
  });
  app.get("/v1/splash/rounds/:id/results", async (c) => {
    const raw = c.req.param("id");
    if (!ROUND_ID.test(raw)) return c.json({ error: "not_found" }, 404);
    const results = await store.roundResults(Number(raw));
    // Unknown and still-open rounds look the same: no results yet.
    if (!results) return c.json({ error: "not_found" }, 404);
    return c.json({
      round_id: results.roundId,
      starts_at: results.startsAt,
      ends_at: results.endsAt,
      closed_at: results.closedAt,
      frogs: results.lots.map((lot) => ({
        submission_id: lot.submissionId,
        width: lot.width,
        height: lot.height,
        background_removed: lot.backgroundRemoved,
        image_path: imagePath(lot.submissionId),
        outcome: lot.amount === null ? "no_bids" : "won",
        bidder_count: lot.bidderCount,
        amount: lot.amount,
        name: lot.username,
        name_outcome: lot.nameOutcome,
        claim_deadline: lot.claimDeadline,
        winner: profile(lot.winner),
      })),
    });
  });
}
