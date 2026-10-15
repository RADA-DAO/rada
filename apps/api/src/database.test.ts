import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "./database.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

Deno.test(
  "API to PostgreSQL: stable UUID, isolated identity and private projection",
  async () => {
    // Provision fixture-only restricted logins outside migrations, as production does.
    const admin = new pg.Pool({
      connectionString: Deno.env.get("API_TEST_DATABASE_URL"),
    });
    let auth: pg.Pool | undefined;
    let service: pg.Pool | undefined;
    try {
      const version = await admin.query("SHOW server_version_num");
      assert(
        Number(version.rows[0].server_version_num) >= 170000 &&
          Number(version.rows[0].server_version_num) < 180000,
      );
      await admin.query(
        "CREATE ROLE api_fixture_auth LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_auth TO api_fixture_auth; CREATE ROLE api_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_service TO api_fixture_service;",
      );
      const url = new URL(Deno.env.get("API_TEST_DATABASE_URL")!);
      url.username = "api_fixture_auth";
      url.password = "fixture-only";
      auth = new pg.Pool({ connectionString: url.toString(), max: 1 });
      url.username = "api_fixture_service";
      service = new pg.Pool({ connectionString: url.toString(), max: 1 });
      const app = createApp(
        FIXTURE_TOKEN,
        new PostgresIdentityStore(auth, service),
      );
      async function me(id: number, query = "") {
        const response = await app.request("/me" + query, {
          headers: {
            authorization: `tma ${await signed({ user: JSON.stringify({ id }) })}`,
          },
        });
        assert(response.status === 200);
        return await response.json();
      }
      const first = await me(101);
      const second = await me(102);
      assert(first.subject_id !== second.subject_id);
      assert(
        (await me(101, "?subject_id=" + second.subject_id)).subject_id ===
          first.subject_id,
      );
      await admin.query(
        "UPDATE identity.subjects SET selected_frog_id = gen_random_uuid() WHERE subject_id = $1",
        [first.subject_id],
      );
      const own = await me(101);
      assert(
        own.profile.visibility === "private" && own.profile.public === null,
      );
      assert(
        own.membership.status === "unavailable" &&
          Object.keys(own).length === 3,
      );
      assert(
        (await service.query("SELECT * FROM identity.subjects")).rows.length ===
          0,
        "Transaction context leaked",
      );
      for (const [pool, query] of [
        [
          service,
          "INSERT INTO identity.role_grants(subject_id,role_name) VALUES ('" +
            first.subject_id +
            "','admin')",
        ],
        [service, "SELECT identity.resolve_telegram(103)"],
        [auth, "SELECT * FROM identity.subjects"],
      ] as const) {
        let rejected = false;
        try {
          await pool.query(query);
        } catch {
          rejected = true;
        }
        assert(rejected, "Restricted credential exceeded permissions");
      }
    } finally {
      await auth?.end();
      await service?.end();
      await admin.query(
        "DROP ROLE IF EXISTS api_fixture_auth; DROP ROLE IF EXISTS api_fixture_service",
      );
      await admin.end();
    }
  },
);
