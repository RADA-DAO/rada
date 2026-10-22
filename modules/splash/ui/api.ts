import type {
  ModuleApi,
  ModuleResponse,
} from "../../../packages/platform-sdk/src/index.ts";

/** A person shown only through their public frog, otherwise null (anonymous). */
export type Profile = { username: string } | null;
export type Lot = {
  submissionId: string;
  imageUrl: string;
  author: Profile;
  bidderCount: number;
};
export type Round = {
  roundId: number;
  endsAt: number;
  acceptingBids: boolean;
  lots: Lot[];
};
export type OwnBid = {
  roundId: number;
  submissionId: string;
  amount: string;
  name: string;
  roundEndsAt: number;
  status: "active" | "won" | "lost";
  nameContested: boolean;
};
export type ClaimState = "open" | "expired" | "claimed" | "burned";
export type Claim = {
  submissionId: string;
  amount: string;
  /** Null when the name is chosen at claim. */
  name: string | null;
  claimDeadline: number;
  state: ClaimState;
  paymentStatus: "prepared" | "unknown" | "paid" | "cancelled" | null;
};
export type ResultLot = {
  submissionId: string;
  imageUrl: string;
  outcome: "won" | "archived";
  bidderCount: number;
  amount: string | null;
  name: string | null;
  winner: Profile;
  claimDeadline: number | null;
};
export type RoundResults = {
  roundId: number;
  startsAt: number;
  lots: ResultLot[];
};
export type NameStatus = "available" | "taken" | "invalid";
export type Submitted = { imageUrl: string; backgroundRemoved: boolean };
export type StartedClaim = { status: "ready" | "paid"; payment: unknown };

/** A refused request: `code` is the API error, `retryAfter` its wait in seconds. */
export class SplashError extends Error {
  readonly retryAfter: number | null;
  readonly payment: unknown;
  constructor(
    code: string,
    retryAfter: number | null = null,
    payment?: unknown,
  ) {
    super(code);
    this.retryAfter = retryAfter;
    this.payment = payment;
  }
}

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f-]{36}$/i;
const AMOUNT = /^[1-9][0-9]{0,77}$/;
const bad = (): never => {
  throw new SplashError("unavailable");
};
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : bad();
const list = (value: unknown, max = 500): unknown[] =>
  Array.isArray(value) && value.length <= max ? value : bad();
const id = (value: unknown): string =>
  typeof value === "string" && UUID.test(value) ? value.toLowerCase() : bad();
const amount = (value: unknown): string =>
  typeof value === "string" && AMOUNT.test(value) ? value : bad();
const amountOrNull = (value: unknown) =>
  value === null ? null : amount(value);
const time = (value: unknown): number => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : bad();
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : bad();
const text = (value: unknown): string =>
  typeof value === "string" && value.length <= 64 ? value : bad();
const textOrNull = (value: unknown) => (value === null ? null : text(value));
const profile = (value: unknown): Profile =>
  value === null ? null : { username: text(record(value).username) };
const oneOf = <T extends string>(value: unknown, options: readonly T[]): T =>
  options.includes(value as T) ? (value as T) : bad();

function failure(response: ModuleResponse): SplashError {
  const body =
    response.body && typeof response.body === "object"
      ? (response.body as Json)
      : {};
  if (response.status === 401) return new SplashError("expired");
  const code =
    typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error)
      ? body.error
      : "unavailable";
  return new SplashError(code, response.retryAfter, body.payment);
}

export function splashClient(api: ModuleApi) {
  // The platform client accepts only this module's plain API paths.
  const image = (path: unknown) =>
    typeof path === "string" && path.length <= 128 ? api.url(path) : bad();
  async function call(
    method: "GET" | "POST",
    path: string,
    options: Parameters<ModuleApi["request"]>[2] = {},
  ): Promise<Json> {
    const response = await api
      .request(method, path, options)
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") throw error;
        throw new SplashError(
          error instanceof Error && error.message === "expired"
            ? "expired"
            : "unavailable",
        );
      });
    if (response.status < 200 || response.status > 299) throw failure(response);
    return record(response.body);
  }
  return {
    imageUrl: image,
    async round(signal: AbortSignal): Promise<Round | null> {
      const body = await call("GET", "/v1/splash/round", {
        auth: false,
        signal,
      });
      if (body.round === null) return null;
      const round = record(body.round);
      return {
        roundId: count(round.round_id),
        endsAt: time(round.ends_at),
        acceptingBids: round.accepting_bids === true,
        lots: list(round.frogs).map((item) => {
          const lot = record(item);
          return {
            submissionId: id(lot.submission_id),
            imageUrl: image(lot.image_path),
            author: profile(lot.author),
            bidderCount: count(lot.bidder_count),
          };
        }),
      };
    },
    async myBids(signal: AbortSignal): Promise<OwnBid[]> {
      const body = await call("GET", "/v1/splash/bids/mine", { signal });
      return list(body.bids).map((item) => {
        const bid = record(item);
        return {
          roundId: count(bid.round_id),
          submissionId: id(bid.submission_id),
          amount: amount(bid.amount),
          name: text(bid.name),
          roundEndsAt: time(bid.round_ends_at),
          status: oneOf(bid.status, ["active", "won", "lost"] as const),
          nameContested: bid.name_contested === true,
        };
      });
    },
    /** Wins with their claim state; empty while claims are not enabled. */
    async myClaims(signal: AbortSignal): Promise<Claim[]> {
      let body: Json;
      try {
        body = await call("GET", "/v1/splash/claims/mine", { signal });
      } catch (error) {
        if (error instanceof SplashError && error.message === "not_found")
          return [];
        throw error;
      }
      return list(body.claims).map(claim);
    },
    async claim(frogId: string, signal: AbortSignal): Promise<Claim> {
      const body = await call("GET", `/v1/splash/claims/${id(frogId)}`, {
        signal,
      });
      return claim(body.claim);
    },
    async startClaim(
      frogId: string,
      sender: string,
      name: string | null,
      signal: AbortSignal,
    ): Promise<StartedClaim> {
      const body = await call("POST", `/v1/splash/claims/${id(frogId)}`, {
        body: { json: name === null ? { sender } : { sender, name } },
        signal,
      });
      return {
        status: oneOf(body.status, ["ready", "paid"] as const),
        payment: body.payment,
      };
    },
    async placeBid(
      submissionId: string,
      units: string,
      name: string,
      signal: AbortSignal,
    ): Promise<{ nameContested: boolean }> {
      const body = await call("POST", "/v1/splash/bids", {
        body: { json: { submission_id: submissionId, amount: units, name } },
        signal,
      });
      return { nameContested: body.name_contested === true };
    },
    async nameStatus(name: string, signal: AbortSignal): Promise<NameStatus> {
      const body = await call(
        "GET",
        `/v1/splash/names/${encodeURIComponent(name)}`,
        { signal },
      );
      return oneOf(body.status, ["available", "taken", "invalid"] as const);
    },
    async results(roundId: number, signal: AbortSignal): Promise<RoundResults> {
      const body = await call(
        "GET",
        `/v1/splash/rounds/${String(roundId)}/results`,
        {
          auth: false,
          signal,
        },
      );
      return {
        roundId: count(body.round_id),
        startsAt: time(body.starts_at),
        lots: list(body.frogs).map((item) => {
          const lot = record(item);
          return {
            submissionId: id(lot.submission_id),
            imageUrl: image(lot.image_path),
            outcome: oneOf(lot.outcome, ["won", "archived"] as const),
            bidderCount: count(lot.bidder_count),
            amount: amountOrNull(lot.amount),
            name: textOrNull(lot.name),
            winner: profile(lot.winner),
            claimDeadline:
              lot.claim_deadline === null ? null : time(lot.claim_deadline),
          };
        }),
      };
    },
    async mySubmissions(signal: AbortSignal) {
      const body = await call("GET", "/v1/splash/submissions/mine", { signal });
      return list(body.submissions).map((value) => {
        const item = record(value);
        return {
          submissionId: id(item.submission_id),
          state: oneOf(item.state, [
            "in_pond",
            "archived",
            "won",
            "claimed",
            "burned",
          ] as const),
          imageUrl: image(item.image_path),
        };
      });
    },
    async submit(png: Blob, signal: AbortSignal): Promise<Submitted> {
      const body = await call("POST", "/v1/splash/submissions", {
        body: { bytes: png, contentType: "image/png" },
        signal,
      });
      return {
        imageUrl: image(body.image_path),
        backgroundRemoved: body.background_removed === true,
      };
    },
  };
}
export type SplashClient = ReturnType<typeof splashClient>;

function claim(value: unknown): Claim {
  const item = record(value);
  const payment = item.payment === null ? null : record(item.payment);
  return {
    submissionId: id(item.submission_id),
    amount: amount(item.amount),
    name: textOrNull(item.name),
    claimDeadline: time(item.claim_deadline),
    state: oneOf(item.state, ["open", "expired", "claimed", "burned"] as const),
    paymentStatus: payment
      ? oneOf(payment.status, [
          "prepared",
          "unknown",
          "paid",
          "cancelled",
        ] as const)
      : null,
  };
}
