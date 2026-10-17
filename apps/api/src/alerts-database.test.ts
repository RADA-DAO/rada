import pg from "pg";
import { PostgresAlertStore } from "../../../modules/ops/index.ts";
import { assert } from "./fixtures.ts";

Deno.test(
  "alert summary is count-only and the watermark moves forward",
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
        "CREATE ROLE alerts_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT ops_service TO alerts_fixture_service;",
      );
      const url = new URL(databaseUrl);
      url.username = "alerts_fixture_service";
      url.password = "fixture-only";
      service = new pg.Pool({ connectionString: url.toString() });
      const insert = (name: string, route: string) =>
        admin.query(
          "INSERT INTO ops.client_errors(build, route, kind, name, message, frames) VALUES ('alertfx', $2, 'error', $1, 'unknown', '[\"f.js:1:1\"]')",
          [name, route],
        );
      await admin.query("UPDATE ops.alert_state SET client_errors_after = 0");
      await admin.query("DELETE FROM ops.client_errors");
      await insert("TypeError", "home");
      await insert("TypeError", "home");
      await insert("RangeError", "wallet");
      const store = new PostgresAlertStore(service);
      const first = await store.summary();
      assert(first.total === 3 && first.groups.length === 2);
      assert(first.groups[0]?.label === "error/TypeError/home");
      assert(first.groups[0]?.total === 2);
      assert(!JSON.stringify(first).includes("secret"));
      await store.advance(first.lastId);
      assert((await store.summary()).total === 0);
      await store.advance(1);
      assert((await store.summary()).total === 0);
      await insert("TypeError", "home");
      const next = await store.summary();
      assert(next.total === 1);
      await admin.query(
        "DELETE FROM ops.client_errors WHERE build = 'alertfx'",
      );
      await admin.query("UPDATE ops.alert_state SET client_errors_after = 0");
    } finally {
      await service?.end();
      await admin.query("DROP ROLE IF EXISTS alerts_fixture_service;");
      await admin.end();
    }
  },
);
