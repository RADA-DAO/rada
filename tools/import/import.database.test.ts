import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { readSource } from "./source.ts";
import { runImport } from "./runner.ts";
import { hash, type Frog } from "./model.ts";
const person = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const frog = (n: number) =>
  `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
await test("synthetic legacy import, read-only planning, resume and exact verification", async () => {
  const databaseUrl = process.env.IMPORT_TEST_DATABASE_URL;
  assert.ok(
    databaseUrl,
    "Explicit disposable IMPORT_TEST_DATABASE_URL required",
  );
  const admin = new pg.Client({ connectionString: databaseUrl });
  const sourceUrl = new URL(databaseUrl);
  sourceUrl.pathname = "/rada_import_fixture";
  const source = new pg.Client({ connectionString: sourceUrl.toString() });
  const target = new pg.Client({ connectionString: databaseUrl });
  await admin.connect();
  try {
    await admin.query("CREATE DATABASE rada_import_fixture");
    await source.connect();
    await target.connect();
    await source.query(
      await readFile(new URL("fixture.sql", import.meta.url), "utf8"),
    );
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const snapshot = await readSource(source);
    await source.query("COMMIT");
    assert.ok(
      snapshot.skipped.some(
        (s) =>
          s.category ===
            "excluded_field:public.ecosystem_users.global_balance" &&
          s.count === 8,
      ),
    );
    assert.equal(snapshot.counts.people, 8);
    assert.equal(snapshot.counts.frogs, 8);
    const twice = snapshot.records.find(
      (r) => r.entity === "frogs" && r.id === frog(1),
    )?.value as Frog;
    assert.equal(twice.events.length, 3);
    assert.equal(twice.creator, person(1));
    assert.equal(twice.owner, person(3));
    assert.deepEqual(twice.background_proof, {
      synthetic: true,
      protocolVersion: 1,
    });
    const synthetic = snapshot.records.find(
      (r) => r.entity === "frogs" && r.id === frog(2),
    )?.value as Frog;
    assert.ok(synthetic.events[1]?.key.endsWith(":imported"));
    assert.ok(
      snapshot.skipped.some(
        (s) => s.category === "people_without_telegram_link" && s.count === 1,
      ),
    );
    for (const name of [
      "jpegpe_game_accounts",
      "wallet_links",
      "sessions",
      "admin_roles",
      "challenges",
      "global_balance_history",
    ])
      assert.ok(
        snapshot.skipped.some(
          (s) => s.category === `entire_table:public.${name}` && s.count > 0,
        ),
      );
    await target.query("SET ROLE legacy_import");
    await assert.rejects(
      target.query("SELECT * FROM identity.subjects"),
      /permission denied/,
    );
    await assert.rejects(
      target.query("SELECT * FROM jpegpe.frogs"),
      /permission denied/,
    );
    await assert.rejects(
      target.query("SELECT wallet.request_balance_refresh()"),
    );
    const before = (
      await admin.query<{ count: string }>(
        "SELECT count(*) FROM identity.subjects",
      )
    ).rows;
    const dry = await runImport(target, snapshot, "dry-run", 3);
    assert.equal(dry.ok, false);
    assert.equal(
      dry.conflicts.filter((c) => c.reason === "source_name_collision").length,
      2,
    );
    assert.deepEqual(
      (
        await admin.query<{ count: string }>(
          "SELECT count(*) FROM identity.subjects",
        )
      ).rows,
      before,
    );
    assert.equal(
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM ops.import_mappings",
        )
      ).rows[0]?.n,
      0,
    );
    // Interrupt after an earlier batch committed, then resume using exactly the same source.
    await admin.query(`CREATE FUNCTION ops.fixture_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (SELECT count(*) FROM ops.import_mappings) >= 6 THEN
        RAISE EXCEPTION 'synthetic interruption'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_interrupt BEFORE INSERT ON ops.import_checkpoints
        FOR EACH ROW EXECUTE FUNCTION ops.fixture_interrupt();`);
    await assert.rejects(
      runImport(target, snapshot, "import", 3),
      /synthetic interruption/,
    );
    await admin.query(
      "DROP TRIGGER fixture_interrupt ON ops.import_checkpoints; DROP FUNCTION ops.fixture_interrupt()",
    );
    assert.equal(
      (
        await admin.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM ops.import_mappings",
        )
      ).rows[0]?.n,
      3,
    );
    const imported = await runImport(target, snapshot, "import", 3);
    assert.equal(imported.entities.people?.imported, 8);
    assert.equal(imported.entities.frogs?.imported, 5);
    assert.equal(imported.entities.selections?.imported, 1);
    assert.equal(imported.ok, false);
    const dump = async () =>
      (
        await admin.query<{ value: unknown }>(`SELECT jsonb_build_object(
      'people',(SELECT jsonb_agg(s ORDER BY subject_id) FROM identity.subjects s),
      'frogs',(SELECT jsonb_agg(f ORDER BY frog_id) FROM jpegpe.frogs f),
      'events',(SELECT jsonb_agg(e ORDER BY event_id) FROM jpegpe.ownership_events e),
      'maps',(SELECT jsonb_agg(m ORDER BY source_table,source_pk) FROM ops.import_mappings m),
      'checkpoints',(SELECT jsonb_agg(c ORDER BY batch_key) FROM ops.import_checkpoints c)) AS value`)
      ).rows;
    const after = hash(await dump());
    await runImport(target, snapshot, "import", 3);
    assert.equal(hash(await dump()), after);
    assert.equal(
      (
        await admin.query<{ selected_frog_id: string | null }>(
          "SELECT selected_frog_id FROM identity.subjects WHERE subject_id=$1",
          [person(1)],
        )
      ).rows[0]?.selected_frog_id,
      null,
    );
    assert.equal(
      (
        await admin.query<{ selected_frog_id: string | null }>(
          "SELECT selected_frog_id FROM identity.subjects WHERE subject_id=$1",
          [person(3)],
        )
      ).rows[0]?.selected_frog_id,
      frog(1),
    );
    // Resolve only the synthetic conflicting names before a fresh rehearsal.
    await source.query(
      "UPDATE public.jpegpe_frog_submissions SET username='@Resolved_' || right(id::text,1) WHERE id=ANY($1::uuid[])",
      [[frog(5), frog(6)]],
    );
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const clean = await readSource(source);
    await source.query("COMMIT");
    assert.equal((await runImport(target, clean, "dry-run", 3)).ok, true);
    assert.equal((await runImport(target, clean, "import", 3)).ok, true);
    const verified = await runImport(target, clean, "verify", 3);
    assert.equal(verified.ok, true);
    for (const entity of Object.values(verified.entities)) {
      assert.equal(entity.mismatches, 0);
      assert.equal(entity.source_checksum, entity.target_checksum);
    }
    await admin.query(
      "UPDATE jpegpe.frogs SET background_color='#000000' WHERE frog_id=$1",
      [frog(1)],
    );
    assert.equal((await runImport(target, clean, "verify")).ok, false);
    await assert.rejects(
      admin.query("DELETE FROM jpegpe.ownership_events WHERE frog_id=$1", [
        frog(1),
      ]),
      /immutable/,
    );
    await assert.rejects(
      target.query("DELETE FROM ops.import_mappings"),
      /permission denied/,
    );
  } finally {
    await source.end();
    await target.end();
    await admin.query("DROP DATABASE IF EXISTS rada_import_fixture");
    await admin.end();
  }
});
