import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import {
  PostgresSplashStore,
  readSubmissionAuthor,
} from "../../../modules/splash/index.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
import {
  decodeBase64,
  FROG_PNG_BASE64,
  OTHER_FROG_PNG_BASE64,
} from "./fixtures/splash-frog.ts";

Deno.test(
  "frog submission, duplicate refusal, pond projection and author lookup through PostgreSQL",
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
        "CREATE ROLE splash_fixture_auth LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_auth TO splash_fixture_auth; CREATE ROLE splash_fixture_identity LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_service TO splash_fixture_identity; CREATE ROLE splash_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT splash_service TO splash_fixture_service;",
      );
      const pool = (username: string) => {
        const url = new URL(databaseUrl);
        url.username = username;
        url.password = "fixture-only";
        const result = new pg.Pool({ connectionString: url.toString() });
        pools.push(result);
        return result;
      };
      const auth = pool("splash_fixture_auth");
      const service = pool("splash_fixture_service");
      const identity = new PostgresIdentityStore(
        auth,
        pool("splash_fixture_identity"),
      );
      const store = new PostgresSplashStore(auth, service);
      const app = createApp(
        FIXTURE_TOKEN,
        identity,
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
      const headers = { authorization: `tma ${await signed()}` };
      const submit = (bytes: Uint8Array, extra: Record<string, string> = {}) =>
        app.request("/v1/splash/submissions", {
          method: "POST",
          headers: { "content-type": "image/png", ...headers, ...extra },
          body: bytes,
        });
      const first = await submit(decodeBase64(FROG_PNG_BASE64));
      assert(first.status === 201);
      const created = await first.json();
      // The same processed image cannot be submitted twice, by anyone.
      assert((await submit(decodeBase64(FROG_PNG_BASE64))).status === 409);
      const second = await submit(decodeBase64(OTHER_FROG_PNG_BASE64));
      assert(second.status === 201);

      const mine = await (
        await app.request("/v1/splash/submissions/mine", { headers })
      ).json();
      assert(mine.submissions.length === 2);
      assert(
        mine.submissions.every((s: { state: string }) => s.state === "in_pond"),
      );
      const otherHeaders = {
        authorization: `tma ${await signed({ user: JSON.stringify({ id: 102, username: "other" }) })}`,
      };
      const theirs = await (
        await app.request("/v1/splash/submissions/mine", {
          headers: otherHeaders,
        })
      ).json();
      assert(theirs.submissions.length === 0);

      const pond = await (await app.request("/v1/splash/pond")).json();
      const entry = pond.frogs.find(
        (f: { submission_id: string }) =>
          f.submission_id === created.submission_id,
      );
      assert(
        entry && entry.author === null && entry.background_removed === true,
      );
      assert(!JSON.stringify(entry).includes("subject"));

      const image = await app.request(created.image_path);
      assert(image.status === 200);
      assert(image.headers.get("content-type") === "image/png");
      const bytes = new Uint8Array(await image.arrayBuffer());
      assert(bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47);
      assert(
        (
          await app.request(
            `/v1/splash/submissions/${crypto.randomUUID()}/image`,
          )
        ).status === 404,
      );

      // The author id is available server-side for the later "no self-bid" rule.
      const client = await service.connect();
      try {
        const author = await readSubmissionAuthor(
          client,
          created.submission_id,
        );
        const expected = await admin.query(
          "SELECT author_subject_id FROM splash.submissions WHERE submission_id = $1",
          [created.submission_id],
        );
        assert(author === expected.rows[0].author_subject_id);
        assert(
          (await readSubmissionAuthor(client, crypto.randomUUID())) === null,
        );
      } finally {
        client.release();
      }
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query(
        "DROP ROLE IF EXISTS splash_fixture_auth; DROP ROLE IF EXISTS splash_fixture_identity; DROP ROLE IF EXISTS splash_fixture_service;",
      );
      await admin.end();
    }
  },
);
