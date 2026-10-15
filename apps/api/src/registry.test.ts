import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import { PostgresRegistryStore } from "../../../modules/apps/index.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

Deno.test(
  "registry API to PostgreSQL: author, review, publish, rollback and withdrawal",
  async () => {
    const databaseUrl = Deno.env.get("API_TEST_DATABASE_URL");
    if (!databaseUrl)
      throw new Error(
        "API_TEST_DATABASE_URL required for disposable PostgreSQL 17",
      );
    const url = new URL(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2
    )
      throw new Error("Invalid API_TEST_DATABASE_URL");
    const admin = new pg.Pool({ connectionString: url.toString() });
    let auth: pg.Pool | undefined;
    let identity: pg.Pool | undefined;
    let registry: pg.Pool | undefined;
    try {
      const version = await admin.query("SHOW server_version_num");
      assert(
        Number(version.rows[0].server_version_num) >= 170000 &&
          Number(version.rows[0].server_version_num) < 180000,
      );
      await admin.query(
        "CREATE ROLE apps_fixture_auth LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_auth TO apps_fixture_auth; CREATE ROLE apps_fixture_identity LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_service TO apps_fixture_identity; CREATE ROLE apps_fixture_registry LOGIN PASSWORD 'fixture-only' INHERIT; GRANT apps_service TO apps_fixture_registry;",
      );
      url.username = "apps_fixture_auth";
      url.password = "fixture-only";
      auth = new pg.Pool({ connectionString: url.toString(), max: 2 });
      url.username = "apps_fixture_identity";
      identity = new pg.Pool({ connectionString: url.toString(), max: 1 });
      url.username = "apps_fixture_registry";
      registry = new pg.Pool({ connectionString: url.toString(), max: 2 });
      const app = createApp(
        FIXTURE_TOKEN,
        new PostgresIdentityStore(auth, identity),
        [],
        undefined,
        false,
        new PostgresRegistryStore(auth, registry),
        "https://artifacts.example",
      );
      const header = async (id: number, age = 0) => ({
        authorization: `tma ${await signed({ auth_date: String(Math.floor(Date.now() / 1000) - age), user: JSON.stringify({ id }) })}`,
        "content-type": "application/json",
      });
      const request = async (
        id: number,
        method: string,
        path: string,
        body?: unknown,
        age = 0,
      ) =>
        app.request(path, {
          method,
          headers: await header(id, age),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const manifest = {
        name: "Fixture App",
        author: "Fixture",
        trustLevel: "official",
        designRoute: "free-style",
        permissions: ["theme.read", "money.transfer"],
        minPlatformVersion: "1.0.0",
      };
      const digest = "a".repeat(64);
      const create = (id: number) =>
        request(id, "POST", "/apps/fixture.app/versions", {
          manifest,
          sha256: digest,
        });
      const initial = await create(101);
      const initialText = await initial.text();
      assert(
        initial.status === 201,
        `submit: ${initial.status} ${initialText}`,
      );
      const initialVersion = JSON.parse(initialText);
      const firstResponse = await create(101);
      assert(firstResponse.status === 201);
      const first = await firstResponse.json();
      assert(first.versionNo === 2 && first.status === "pending");
      assert(
        (await create(102)).status === 403,
        "another author must not replace ownership",
      );
      assert((await request(101, "GET", "/apps/review-queue")).status === 403);
      assert(
        (
          await request(
            101,
            "POST",
            `/apps/fixture.app/versions/${first.versionId}/approve`,
            { reason: "reviewed" },
          )
        ).status === 403,
      );
      const reviewerRow = (
        await admin.query<{ subject_id: string }>(
          "SELECT identity.resolve_telegram(102) AS subject_id",
        )
      ).rows[0];
      assert(reviewerRow);
      const reviewer = reviewerRow.subject_id;
      await admin.query(
        "INSERT INTO identity.role_grants(subject_id,role_name) VALUES($1,'apps.reviewer')",
        [reviewer],
      );
      assert(
        (await request(102, "GET", "/apps/review-queue", undefined, 3700))
          .status === 401,
        "private review queue requires a fresh privileged signature",
      );
      const queue = await request(102, "GET", "/apps/review-queue");
      assert(
        queue.status === 200 && (await queue.json()).versions.length === 2,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${first.versionId}/approve`,
            { reason: "reviewed" },
            3700,
          )
        ).status === 401,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${first.versionId}/approve`,
            { reason: "" },
          )
        ).status === 400,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${first.versionId}/approve`,
            { reason: "reviewed" },
          )
        ).status === 200,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${first.versionId}/approve`,
            { reason: "again" },
          )
        ).status === 409,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${first.versionId}/publish`,
            {},
          )
        ).status === 200,
      );
      const publicOne = await app.request("/apps/published");
      const listing = (await publicOne.json()).apps;
      assert(listing.length === 1 && listing[0].versionId === first.versionId);
      assert(
        !JSON.stringify(listing).includes(reviewer) &&
          !JSON.stringify(listing).includes("authorId"),
      );
      assert(
        listing[0].artifactUrl ===
          `https://artifacts.example/artifacts/${digest}.html`,
      );
      assert(
        JSON.stringify(listing[0].grantedPermissions) ===
          '["theme.read","money.transfer"]',
      );
      const nextResponse = await create(101);
      const next = await nextResponse.json();
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${next.versionId}/reject`,
            { reason: "needs changes" },
          )
        ).status === 200,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${next.versionId}/publish`,
            {},
          )
        ).status === 409,
      );
      const third = await (await create(101)).json();
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${third.versionId}/approve`,
            { reason: "reviewed" },
          )
        ).status === 200,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${third.versionId}/publish`,
            {},
          )
        ).status === 200,
      );
      assert(
        (
          await request(
            102,
            "POST",
            `/apps/fixture.app/versions/${initialVersion.versionId}/approve`,
            {
              reason: "reviewed but not published",
            },
          )
        ).status === 200,
      );
      assert(
        (
          await request(102, "POST", "/apps/fixture.app/rollback", {
            versionId: initialVersion.versionId,
          })
        ).status === 409,
        "rollback requires a previously published version",
      );
      assert(
        (
          await request(102, "POST", "/apps/fixture.app/rollback", {
            versionId: first.versionId,
          })
        ).status === 200,
      );
      assert(
        (
          await request(102, "POST", "/apps/fixture.app/rollback", {
            versionId: third.versionId,
          })
        ).status === 409,
      );
      assert(
        (
          await request(102, "POST", "/apps/fixture.app/withdraw", {
            reason: "safety",
          })
        ).status === 200,
      );
      assert(
        (await (await app.request("/apps/published")).json()).apps.length === 0,
      );
      let blocked = false;
      try {
        await registry.query("SELECT * FROM apps.versions");
      } catch {
        blocked = true;
      }
      assert(blocked, "service role must not select base tables");
      blocked = false;
      try {
        await registry.query(
          "INSERT INTO identity.role_grants(subject_id,role_name) VALUES($1,'apps.reviewer')",
          [reviewer],
        );
      } catch {
        blocked = true;
      }
      assert(blocked, "registry role must not mint reviewers");
      const immutable = await admin.query(
        "SELECT version_id,manifest,approved_by,review_reason FROM apps.versions WHERE version_id=$1",
        [first.versionId],
      );
      assert(
        immutable.rows[0].approved_by === reviewer &&
          immutable.rows[0].review_reason === "reviewed",
      );
      blocked = false;
      try {
        await admin.query(
          "UPDATE apps.versions SET manifest='{}'::jsonb WHERE version_id=$1",
          [first.versionId],
        );
      } catch {
        blocked = true;
      }
      assert(
        blocked,
        "version metadata must remain immutable even at database boundary",
      );
      blocked = false;
      try {
        await admin.query("DELETE FROM apps.audit_events WHERE version_id=$1", [
          first.versionId,
        ]);
      } catch {
        blocked = true;
      }
      assert(blocked, "review audit must remain append-only");
    } finally {
      await registry?.end();
      await identity?.end();
      await auth?.end();
      await admin.query(
        "TRUNCATE apps.audit_events, apps.versions, apps.registry RESTART IDENTITY CASCADE",
      );
      await admin.query(
        "DELETE FROM identity.role_grants WHERE role_name='apps.reviewer' AND subject_id IN (SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id=102)",
      );
      await admin.query(
        "DROP ROLE IF EXISTS apps_fixture_registry; DROP ROLE IF EXISTS apps_fixture_identity; DROP ROLE IF EXISTS apps_fixture_auth",
      );
      await admin.end();
    }
  },
);
