import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import { drawFrogColors } from "../../../modules/jpegpe/index.ts";
import {
  ClaimService,
  PostgresClaimDb,
  PostgresSplashStore,
} from "../../../modules/splash/index.ts";
import {
  PaymentChain,
  type PaymentRecord,
  PostgresPaymentStore,
} from "../../../modules/wallet/index.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

/** Offline chain: a fixed fee, and a finalized receipt once `confirmed`. */
class FixtureChain extends PaymentChain {
  confirmed = false;
  constructor() {
    super(
      () => Promise.reject(new Error("offline")),
      (owner) => Promise.resolve(owner),
    );
  }
  override estimateFee() {
    return Promise.resolve({
      nano: "1234567",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
  }
  override confirmation(intent: PaymentRecord) {
    const hex = intent.intentId.replaceAll("-", "");
    return Promise.resolve(
      this.confirmed
        ? {
            status: "confirmed" as const,
            hash: hex + hex,
            onChainAt: Math.floor(Date.now() / 1000),
          }
        : { status: "incomplete" as const },
    );
  }
}
// The published synthetic Quicknet beacon; the relays are never contacted.
const beacon = {
  randomness:
    "63eccd98965f616854bf9dc284df5bbf403a800ea60d7a3f3dd4c3a92266b4d5",
  signature:
    "a00b04c2cd76c5e565f416bd7af150b4205ceb1862c429f86ec401c62ad689100f82e7bac26b8ff64bb690a75edcb046",
};
function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected a row");
  return row;
}
const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

Deno.test(
  "claims: paid claim exactly once through the wallet window, burn after the deadline, steward recipient",
  async () => {
    const databaseUrl = Deno.env.get("API_TEST_DATABASE_URL");
    if (
      !databaseUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("Disposable local database required");
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pools: pg.Pool[] = [];
    const roles = {
      auth: "identity_auth",
      identity: "identity_service",
      wallet: "wallet_service",
      splash: "splash_service",
    };
    try {
      for (const [role, grant] of Object.entries(roles))
        await admin.query(
          `CREATE ROLE claims_fixture_${role} LOGIN PASSWORD 'fixture-only' INHERIT; GRANT ${grant} TO claims_fixture_${role}`,
        );
      const pool = (role: string) => {
        const url = new URL(databaseUrl);
        url.username = `claims_fixture_${role}`;
        url.password = "fixture-only";
        const result = new pg.Pool({ connectionString: url.toString() });
        pools.push(result);
        return result;
      };
      const auth = pool("auth");
      const splashPool = pool("splash");
      const chain = new FixtureChain();
      const payments = new PostgresPaymentStore(auth, pool("wallet"), chain);
      const splash = new PostgresSplashStore(auth, splashPool);
      const claims = new ClaimService(
        new PostgresClaimDb(auth, splashPool),
        payments,
        (input) =>
          drawFrogColors(input, (round) =>
            Promise.resolve({ round, ...beacon }),
          ),
      );
      const app = createApp(
        FIXTURE_TOKEN,
        new PostgresIdentityStore(auth, pool("identity")),
        [],
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        payments,
        {},
        splash,
        claims,
      );
      const call = async (
        id: number,
        method: string,
        path: string,
        body?: unknown,
      ) =>
        await app.request(path, {
          method,
          headers: {
            authorization: `tma ${await signed({ user: JSON.stringify({ id }) })}`,
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const json = async (response: Promise<Response>, status: number) => {
        const result = await response;
        const text = await result.text();
        assert(
          result.status === status,
          `Expected ${status}, got ${result.status}: ${text}`,
        );
        return JSON.parse(text);
      };
      const subject = async (id: number) =>
        one(
          (
            await admin.query<{ id: string }>(
              "SELECT identity.resolve_telegram($1::bigint) AS id",
              [String(id)],
            )
          ).rows,
        ).id;
      const base = 8_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
      const [A, W, O, S] = [base + 1, base + 2, base + 3, base + 4];
      const [author, winner] = [await subject(A), await subject(W)];
      await subject(O);
      const steward = await subject(S);
      const sender = `0:${hex(32)}`;
      await admin.query(
        "INSERT INTO identity.wallet_links(subject_id, address_raw, address_friendly, network) VALUES ($1, $2, 'fixture', '-239')",
        [winner, sender],
      );

      // One frog won in a round that just ended; one won a day earlier (expired).
      const won = async (endedAgo: string, name: string) => {
        const frog = crypto.randomUUID();
        await admin.query(
          "INSERT INTO splash.submissions(submission_id, author_subject_id, submitted_at) VALUES ($1, $2, now() - interval '3 days')",
          [frog, author],
        );
        await admin.query(
          "INSERT INTO splash.submission_images VALUES ($1, $2, 'image/png', 64, 64, true, '\\x01'::bytea)",
          [frog, hex(32)],
        );
        await admin.query(
          "INSERT INTO splash.submission_events(submission_id, state) VALUES ($1, 'in_pond')",
          [frog],
        );
        const round = one(
          (
            await admin.query<{ id: string }>(
              "INSERT INTO splash.rounds(starts_at, ends_at) VALUES (clock_timestamp() - $1::interval - interval '1 hour', clock_timestamp() - $1::interval) RETURNING round_id AS id",
              [endedAgo],
            )
          ).rows,
        ).id;
        await admin.query("INSERT INTO splash.lots VALUES ($1, $2)", [
          round,
          frog,
        ]);
        await admin.query(
          "INSERT INTO splash.bids(round_id, submission_id, bidder_subject_id, amount, username, placed_at, amount_since, name_chosen_at) VALUES ($1, $2, $3, 750, $4, now(), now(), now())",
          [round, frog, winner, name],
        );
        await admin.query("SELECT splash.close_round($1)", [round]);
        return frog;
      };
      const name = `Cl${hex(4)}`;
      const burnedName = `Bu${hex(4)}`;
      const frog = await won("1 second", name);
      const expired = await won("25 hours", burnedName);
      const path = `/v1/splash/claims/${frog}`;
      const payTo = `0:${hex(32)}`;

      // The recipient is the steward's decision.
      await json(call(W, "POST", path, { sender }), 503);
      await json(
        call(S, "PUT", "/v1/splash/settings/recipient", { address: payTo }),
        403,
      );
      await admin.query(
        "INSERT INTO identity.role_grants(subject_id, role_name) VALUES ($1, 'splash.steward')",
        [steward],
      );
      await json(
        call(S, "PUT", "/v1/splash/settings/recipient", { address: "x" }),
        400,
      );
      const saved = await json(
        call(S, "PUT", "/v1/splash/settings/recipient", { address: payTo }),
        200,
      );
      assert(saved.recipient === payTo);

      // Start: only the winner, only from a linked wallet; repeats are one intent.
      await json(call(O, "POST", path, { sender }), 403);
      assert(
        (await json(call(W, "POST", path, { sender: `0:${hex(32)}` }), 403))
          .error === "wallet_not_linked",
      );
      const starts = await Promise.all([
        json(call(W, "POST", path, { sender }), 200),
        json(call(W, "POST", path, { sender, name }), 200),
      ]);
      const intent = starts[0].payment;
      assert(
        starts.every((s) => s.payment.intentId === intent.intentId),
        "one intent",
      );
      assert(
        intent.token === "JPEGPE" &&
          intent.amount === "750" &&
          intent.recipient === payTo &&
          intent.sender === sender &&
          intent.purpose === `splash:${frog}` &&
          intent.feeEstimate.nano === "1234567",
      );
      await json(call(W, "POST", path, { sender, name: "Other" }), 409);

      // The payment window signs it; signing ends 2 minutes before the deadline.
      const signing = await json(
        call(W, "POST", `/me/payments/${intent.intentId}/claim?appId=splash`),
        200,
      );
      const status = await json(call(W, "GET", path), 200);
      assert(
        status.claim.state === "open" &&
          status.claim.payment.status === "unknown",
      );
      const deadline = new Date(status.claim.claim_deadline).getTime();
      assert(
        signing.signRequest.validUntil <= Math.floor(deadline / 1000) - 120,
      );
      assert(
        (await json(call(W, "POST", path, { sender }), 409)).error ===
          "payment_pending",
      );

      // Confirmed on chain: status, the timer and another status race; one claim wins.
      chain.confirmed = true;
      await Promise.all([
        call(W, "GET", path),
        claims.settle(),
        claims.settle(),
        call(W, "GET", path),
      ]);
      const done = await json(call(W, "GET", path), 200);
      assert(
        done.claim.state === "claimed" && done.claim.frog.username === name,
        JSON.stringify(done),
      );
      assert(/^#[0-9A-F]{6}$/.test(done.claim.frog.background_color));
      const frogs = await admin.query(
        "SELECT username, creator_subject_id, current_owner_subject_id FROM jpegpe.frogs WHERE frog_id = $1",
        [frog],
      );
      assert(frogs.rows.length === 1 && frogs.rows[0].username === name);
      assert(
        frogs.rows[0].creator_subject_id === author &&
          frogs.rows[0].current_owner_subject_id === winner,
      );
      const outcomes = await admin.query(
        "SELECT count(*)::int AS n FROM splash.claim_outcomes WHERE submission_id = $1",
        [frog],
      );
      assert(outcomes.rows[0].n === 1);
      assert(
        (await json(call(W, "POST", path, { sender }), 409)).error ===
          "already_claimed",
      );

      // Not paid by the deadline: the timer burns it once and releases the name.
      await json(
        call(W, "POST", `/v1/splash/claims/${expired}`, { sender }),
        409,
      );
      await claims.settle();
      await claims.settle();
      const burned = await json(
        call(W, "GET", `/v1/splash/claims/${expired}`),
        200,
      );
      assert(burned.claim.state === "burned" && burned.claim.name === null);
      const free = await admin.query<{ s: string }>(
        "SELECT jpegpe.username_status($1) AS s",
        [burnedName],
      );
      assert(one(free.rows).s === "available");
      const mine = await json(call(W, "GET", "/v1/splash/claims/mine"), 200);
      assert(mine.claims.length === 2);
      assert(
        !JSON.stringify(mine).includes(winner) &&
          !JSON.stringify(mine).includes(author),
      );
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(
        "DELETE FROM wallet.payment_intents WHERE app_id = 'splash'",
      );
      for (const role of Object.keys(roles))
        await admin.query(`DROP ROLE IF EXISTS claims_fixture_${role}`);
      await admin.end();
    }
  },
);
