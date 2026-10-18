import pg from "pg";
import assert from "node:assert/strict";

Deno.test({
  name: "app CAS serializes writers and revocation erases an in-flight write",
  ignore: !Deno.env.get("API_TEST_DATABASE_URL"),
  async fn() {
    const pool = new pg.Pool({
      connectionString: Deno.env.get("API_TEST_DATABASE_URL"),
    });
    const setup = await pool.connect();
    const first = await pool.connect();
    const second = await pool.connect();
    const slug = `fixture.concurrent.${crypto.randomUUID()}`;
    const hash = "c".repeat(64);
    let subject = "";
    try {
      await setup.query("BEGIN");
      subject =
        (
          await setup.query<{ id: string }>(
            "SELECT identity.resolve_telegram(905903) AS id",
          )
        ).rows[0]?.id ?? "";
      assert(subject);
      await setup.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      await setup.query(
        "INSERT INTO identity.role_grants(subject_id,role_name) VALUES($1,'apps.reviewer') ON CONFLICT DO NOTHING",
        [subject],
      );
      const manifest = {
        name: "Concurrency fixture",
        author: "Fixture",
        designRoute: "standard",
        permissions: ["storage.self"],
        minPlatformVersion: "1.0.0",
      };
      const v = (
        await setup.query<{ value: { versionId: string } }>(
          "SELECT apps.submit_version($1,$2,decode($3,'hex'),$4) AS value",
          [
            slug,
            JSON.stringify(manifest),
            hash,
            `https://artifacts.example/artifacts/${hash}.html`,
          ],
        )
      ).rows[0]?.value.versionId;
      assert(v);
      await setup.query("SELECT apps.review_version($1,$2,true,'Fixture')", [
        slug,
        v,
      ]);
      await setup.query("SELECT apps.publish_version($1,$2)", [slug, v]);
      await setup.query(
        "INSERT INTO identity.consents(subject_id,app_id,capability) VALUES($1,$2,'storage.self')",
        [subject, slug],
      );
      await setup.query("COMMIT");
      const begin = async (client: pg.PoolClient) => {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE apps_service");
        await client.query("SELECT set_config('rada.subject_id',$1,true)", [
          subject,
        ]);
      };
      const write = (client: pg.PoolClient, key: string) =>
        client.query("SELECT apps.own_records($1,$2,'put',$3)", [
          slug,
          hash,
          JSON.stringify({ key, version: 0, value: 1 }),
        ]);
      await begin(first);
      await write(first, "same");
      await begin(second);
      const conflict = assert.rejects(
        () => write(second, "same"),
        /Version conflict/,
      );
      await first.query("COMMIT");
      await conflict;
      await second.query("ROLLBACK");
      await begin(first);
      await write(first, "inflight");
      await second.query("BEGIN");
      await second.query("SET LOCAL ROLE identity_service");
      await second.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      const revoke = second.query(
        "UPDATE identity.consents SET revoked_at=now() WHERE app_id=$1 AND capability='storage.self'",
        [slug],
      );
      await first.query("COMMIT");
      await revoke;
      await second.query("COMMIT");
      assert.equal(
        (
          await setup.query<{ count: string }>(
            "SELECT count(*) FROM apps.records WHERE app_id=$1",
            [slug],
          )
        ).rows[0]?.count,
        "0",
      );
      await begin(first);
      await assert.rejects(() => write(first, "after"), /Consent required/);
      await first.query("ROLLBACK");
    } finally {
      await first.query("ROLLBACK");
      await second.query("ROLLBACK");
      await setup.query("ROLLBACK");
      if (subject) {
        await setup.query("BEGIN");
        await setup.query("SELECT set_config('rada.subject_id',$1,true)", [
          subject,
        ]);
        await setup.query("SELECT apps.withdraw_app($1,'Fixture cleanup')", [
          slug,
        ]);
        await setup.query("COMMIT");
      }
      setup.release();
      first.release();
      second.release();
      await pool.end();
    }
  },
});
