import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresClientErrorStore } from "../../../modules/ops/index.ts";
import { assert, FIXTURE_TOKEN } from "./fixtures.ts";

Deno.test(
  "client error is stored sanitized and old rows are purged",
  async () => {
    const databaseUrl = Deno.env.get("API_TEST_DATABASE_URL");
    if (
      !databaseUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("Disposable local database required");
    const admin = new pg.Pool({ connectionString: databaseUrl });
    let service: pg.Pool | undefined;
    try {
      await admin.query(
        "CREATE ROLE ops_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT ops_service TO ops_fixture_service;",
      );
      const url = new URL(databaseUrl);
      url.username = "ops_fixture_service";
      url.password = "fixture-only";
      service = new pg.Pool({ connectionString: url.toString() });
      const build = `t${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      await admin.query(
        "INSERT INTO ops.client_errors(received_at, build, route, kind, name, message, frames) VALUES (now() - interval '31 days', 'oldfixture', 'home', 'error', 'E', '', '[]')",
      );
      let now = 1_000_000_000;
      const app = createApp(
        FIXTURE_TOKEN,
        {
          me: () => Promise.reject(new Error("unused")),
          ownFrogs: () => Promise.resolve([]),
          selectFrog: () => Promise.resolve(false),
          consents: () => Promise.resolve([]),
          setConsent: () => Promise.resolve(true),
        },
        [],
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        { clientErrors: new PostgresClientErrorStore(service, () => now) },
      );
      const send = () =>
        app.request("/v1/client-errors", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "error",
            name: "TypeError",
            message: "balance 987654321 for a@b.example",
            frames: ["main.js:3:4"],
            build,
            route: "wallet",
          }),
        });
      assert((await send()).status === 204);
      const rows = await admin.query(
        "SELECT message, frames, route FROM ops.client_errors WHERE build = $1",
        [build],
      );
      assert(rows.rowCount === 1);
      assert(rows.rows[0].message === "balance # for <email>");
      assert(rows.rows[0].frames[0] === "main.js:3:4");
      // The first insert purged the 31-day-old row.
      const old = await admin.query(
        "SELECT 1 FROM ops.client_errors WHERE build = 'oldfixture'",
      );
      assert(old.rowCount === 0);
      // Within the hour no further purge runs.
      await admin.query(
        "INSERT INTO ops.client_errors(received_at, build, route, kind, name, message, frames) VALUES (now() - interval '40 days', 'oldfixture', 'home', 'error', 'E', '', '[]')",
      );
      now += 60_000;
      assert((await send()).status === 204);
      assert(
        (
          await admin.query(
            "SELECT 1 FROM ops.client_errors WHERE build = 'oldfixture'",
          )
        ).rowCount === 1,
      );
      now += 3_600_000;
      assert((await send()).status === 204);
      assert(
        (
          await admin.query(
            "SELECT 1 FROM ops.client_errors WHERE build = 'oldfixture'",
          )
        ).rowCount === 0,
      );
      await admin.query("DELETE FROM ops.client_errors WHERE build = $1", [
        build,
      ]);
    } finally {
      await service?.end();
      await admin.query("DROP ROLE IF EXISTS ops_fixture_service;");
      await admin.end();
    }
  },
);
