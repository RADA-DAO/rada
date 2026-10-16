import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import {
  PostgresSplashStore,
  readPendingClaim,
} from "../../../modules/splash/index.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

const hex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

function one<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error("Expected a row");
  return row;
}

Deno.test(
  "rounds: bidding rules, concurrent idempotent close, name conflicts and result visibility through PostgreSQL",
  async () => {
    const databaseUrl = Deno.env.get("API_TEST_DATABASE_URL");
    if (
      !databaseUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("Disposable local database required");
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pools: pg.Pool[] = [];
    try {
      await admin.query(
        "CREATE ROLE rounds_fixture_auth LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_auth TO rounds_fixture_auth; CREATE ROLE rounds_fixture_identity LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_service TO rounds_fixture_identity; CREATE ROLE rounds_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT splash_service TO rounds_fixture_service;",
      );
      const pool = (username: string) => {
        const url = new URL(databaseUrl);
        url.username = username;
        url.password = "fixture-only";
        const result = new pg.Pool({ connectionString: url.toString() });
        pools.push(result);
        return result;
      };
      const auth = pool("rounds_fixture_auth");
      const service = pool("rounds_fixture_service");
      const store = new PostgresSplashStore(auth, service);
      const app = createApp(
        FIXTURE_TOKEN,
        new PostgresIdentityStore(auth, pool("rounds_fixture_identity")),
        [],
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        {},
        store,
      );
      const as = async (id: number) => ({
        authorization: `tma ${await signed({ user: JSON.stringify({ id }) })}`,
      });
      const subject = async (id: number) =>
        one(
          (
            await admin.query<{ id: string }>(
              "SELECT identity.resolve_telegram($1::bigint) AS id",
              [String(id)],
            )
          ).rows,
        ).id;
      // Fresh Telegram ids per run, so reruns on one database stay independent.
      const base = 7_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
      const [A, B, C] = [base + 1, base + 2, base + 3];
      const [author, bidderB, bidderC] = await Promise.all([
        subject(A),
        subject(B),
        subject(C),
      ]);

      // Two frogs by the author in the pond, inserted as fixtures.
      const frogs = [crypto.randomUUID(), crypto.randomUUID()] as const;
      for (const frog of frogs) {
        await admin.query(
          "INSERT INTO splash.submissions(submission_id, author_subject_id) VALUES ($1, $2)",
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
      }
      // A short synthetic round (production rounds last 24 hours).
      const round = one(
        (
          await admin.query<{ round_id: string; ends_at: Date }>(
            "INSERT INTO splash.rounds(starts_at, ends_at) VALUES (clock_timestamp() - interval '1 minute', clock_timestamp() + interval '4 seconds') RETURNING round_id, ends_at",
          )
        ).rows,
      );
      for (const frog of frogs)
        await admin.query("INSERT INTO splash.lots VALUES ($1, $2)", [
          round.round_id,
          frog,
        ]);

      const name = `Ra${hex(4)}`;
      const bid = async (
        id: number,
        frog: string,
        amount: string,
        proposed = name,
      ) =>
        await app.request("/v1/splash/bids", {
          method: "POST",
          headers: { ...(await as(id)), "content-type": "application/json" },
          body: JSON.stringify({ submission_id: frog, amount, name: proposed }),
        });
      assert((await bid(A, frogs[0], "100")).status === 403);
      assert((await bid(B, frogs[0], "0")).status === 400);
      assert((await bid(B, frogs[0], "100", "no spaces")).status === 400);
      assert((await bid(B, crypto.randomUUID(), "100")).status === 404);
      assert((await bid(B, frogs[0], "100")).status === 201);
      assert((await bid(C, frogs[0], "100", `Rb${hex(4)}`)).status === 201);
      const contested = await bid(C, frogs[1], "50");
      assert(contested.status === 201);
      assert((await contested.json()).name_contested === true);
      // Raising replaces the active bid; lowering or repeating is refused.
      assert((await bid(B, frogs[0], "150")).status === 201);
      assert((await bid(B, frogs[0], "120")).status === 409);
      assert((await bid(B, frogs[0], "150")).status === 409);

      const current = await (await app.request("/v1/splash/round")).json();
      if (Number(current.round.round_id) === Number(round.round_id)) {
        const lot = current.round.frogs.find(
          (f: { submission_id: string }) => f.submission_id === frogs[0],
        );
        assert(lot.top_amount === "150" && lot.bidder_count === 2);
        assert(lot.leader === null && lot.author === null);
      }
      assert(!JSON.stringify(current).includes(bidderB));
      assert(
        (await app.request(`/v1/splash/rounds/${round.round_id}/results`))
          .status === 404,
      );

      await new Promise((resolve) =>
        setTimeout(resolve, round.ends_at.getTime() - Date.now() + 300),
      );
      assert((await bid(C, frogs[0], "999")).status === 409);
      // Four closers race; exactly one closes the round.
      const closed = await Promise.all([
        store.advanceRounds(),
        store.advanceRounds(),
        new PostgresSplashStore(auth, service).advanceRounds(),
        store.advanceRounds(),
      ]);
      assert(closed.reduce((a, b) => a + b, 0) === 1, closed.join(","));
      assert((await store.advanceRounds()) === 0);
      const decisions = await admin.query(
        "SELECT count(*)::int AS n FROM splash.lot_results WHERE round_id = $1",
        [round.round_id],
      );
      assert(decisions.rows[0].n === 2);

      // Winner B (raised to 150) keeps the name; C wins frog 2 but loses the name.
      let results = await (
        await app.request(`/v1/splash/rounds/${round.round_id}/results`)
      ).json();
      const first = results.frogs.find(
        (f: { submission_id: string }) => f.submission_id === frogs[0],
      );
      const second = results.frogs.find(
        (f: { submission_id: string }) => f.submission_id === frogs[1],
      );
      assert(first.amount === "150" && first.name === name);
      assert(first.name_outcome === "reserved" && first.winner === null);
      assert(second.amount === "50" && second.name === null);
      assert(second.name_outcome === "conflict" && second.winner === null);
      for (const id of [author, bidderB, bidderC])
        assert(!JSON.stringify(results).includes(id));

      const mineC = await (
        await app.request("/v1/splash/bids/mine", { headers: await as(C) })
      ).json();
      const statuses = Object.fromEntries(
        mineC.bids.map((b: { submission_id: string; status: string }) => [
          b.submission_id,
          b.status,
        ]),
      );
      assert(statuses[frogs[0]] === "lost" && statuses[frogs[1]] === "won");

      // The claim change reads the pending win with its deadline.
      const client = await service.connect();
      try {
        const claim = await readPendingClaim(client, frogs[1]);
        if (!claim) throw new Error("Pending claim missing");
        assert(claim.winnerSubjectId === bidderC && claim.amount === "50");
        assert(claim.username === null && claim.nameOutcome === "conflict");
        assert(
          new Date(claim.claimDeadline).getTime() ===
            round.ends_at.getTime() + 24 * 3600 * 1000,
        );
      } finally {
        client.release();
      }

      // Once B has a public profile, results show B's selected frog.
      const profileFrog = crypto.randomUUID();
      await admin.query(
        "SELECT jpegpe.create_frog($1, $2, $3, '#102030', NULL)",
        [profileFrog, `Pb${hex(4)}`, bidderB],
      );
      await admin.query(
        "UPDATE identity.subjects SET selected_frog_id = $1 WHERE subject_id = $2",
        [profileFrog, bidderB],
      );
      results = await (
        await app.request(`/v1/splash/rounds/${round.round_id}/results`)
      ).json();
      assert(
        results.frogs.find(
          (f: { submission_id: string }) => f.submission_id === frogs[0],
        ).winner.frog_id === profileFrog,
      );
      // The won name is held for the claim: nobody can bid it again.
      const status = await admin.query<{ s: string }>(
        "SELECT jpegpe.username_status(upper($1)) AS s",
        [name],
      );
      assert(one(status.rows).s === "taken");
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query(
        "DROP ROLE IF EXISTS rounds_fixture_auth; DROP ROLE IF EXISTS rounds_fixture_identity; DROP ROLE IF EXISTS rounds_fixture_service;",
      );
      await admin.end();
    }
  },
);
