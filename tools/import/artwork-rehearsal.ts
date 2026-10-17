import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { encodePng, pngDimensions } from "../../modules/splash/png.ts";
import { bucket, digest } from "./artwork-files.ts";
import type { Client } from "pg";
import { artworkFixture } from "./artwork-fixture.ts";
import { planArtwork, runArtwork } from "./artwork.ts";
import type { Snapshot } from "./model.ts";
export async function rehearseArtwork(
  admin: Client,
  source: Client,
  target: Client,
  snapshot: Snapshot,
) {
  const fixture = await artworkFixture();
  try {
    await source.query(
      "ALTER TABLE public.jpegpe_frog_submissions ADD COLUMN storage_path text",
    );
    const ids = snapshot.records
      .filter((r) => r.entity === "frogs")
      .map((r) => r.id);
    for (let i = 0; i < fixture.objects.length; i++)
      await source.query(
        "UPDATE public.jpegpe_frog_submissions SET storage_path=$1 WHERE id=$2",
        [fixture.objects[i]?.key, ids[i]],
      );
    await source.query("BEGIN READ ONLY");
    let plan = await planArtwork(
      source,
      snapshot,
      fixture.root,
      fixture.manifest,
    );
    await source.query("COMMIT");
    for (const reason of [
      "missing_file",
      "checksum_mismatch",
      "unsupported_type",
      "missing_storage_path",
    ])
      assert.ok(plan.conflicts.some((c) => c.reason === reason));
    assert.equal(plan.records.length, 1);
    // Overlay the manifest through the journal and exercise downscaled bytes in SQL.
    const journal = join(fixture.root, "journal.jsonl");
    const blobs = join(fixture.root, "blobs");
    await mkdir(blobs);
    const bytes = encodePng({
      width: 2048,
      height: 64,
      rgba: new Uint8Array(2048 * 64 * 4).fill(127),
    });
    const sha256 = digest(bytes);
    await writeFile(join(blobs, sha256), bytes);
    await writeFile(
      journal,
      JSON.stringify({
        op: "put",
        key: `${bucket}/123/good.png`,
        object: {
          bucket,
          key: "123/good.png",
          sha256,
          metadata: { size: bytes.length, mimetype: "image/png" },
        },
      }),
    );
    plan = await planArtwork(
      source,
      snapshot,
      fixture.root,
      fixture.manifest,
      journal,
      blobs,
    );
    assert.equal(plan.records.length, 1);
    const image = plan.records[0]?.image;
    assert.ok(image);
    assert.deepEqual(pngDimensions(image.bytes), { width: 1024, height: 32 });
    const clean = { ...plan, conflicts: [], total: 1 };
    const count = async () =>
      (
        await admin.query<{ count: string }>(
          "SELECT count(*) FROM jpegpe.artwork",
        )
      ).rows;
    const before = await count();
    assert.equal((await runArtwork(target, clean, "dry-run", 1)).ok, true);
    assert.deepEqual(await count(), before);
    await assert.rejects(
      target.query("SELECT * FROM jpegpe.artwork"),
      /permission denied/,
    );
    await admin.query(`CREATE FUNCTION ops.artwork_interrupt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_system = 'FAIRGROUND_ARTWORK' THEN RAISE EXCEPTION 'synthetic interruption'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER artwork_interrupt BEFORE INSERT ON ops.import_checkpoints FOR EACH ROW EXECUTE FUNCTION ops.artwork_interrupt()`);
    await assert.rejects(
      runArtwork(target, clean, "import", 1),
      /synthetic interruption/,
    );
    assert.deepEqual(await count(), before);
    await admin.query(
      "DROP TRIGGER artwork_interrupt ON ops.import_checkpoints; DROP FUNCTION ops.artwork_interrupt()",
    );
    assert.equal((await runArtwork(target, plan, "import", 1)).ok, false);
    assert.equal((await runArtwork(target, clean, "import", 1)).ok, true);
    assert.equal((await runArtwork(target, clean, "verify", 1)).ok, true);
    const record = clean.records[0];
    assert.ok(record);
    const changed = {
      ...clean,
      records: [{ ...record, value: { changed: true } }],
    };
    assert.ok(
      (await runArtwork(target, changed, "verify")).conflicts.some(
        (c) => c.reason === "source_changed",
      ),
    );
    const altered = {
      ...clean,
      records: [
        { ...record, image: { ...record.image, bytes: new Uint8Array([1]) } },
      ],
    };
    assert.ok(
      (await runArtwork(target, altered, "verify")).conflicts.some(
        (c) => c.reason === "target_mismatch",
      ),
    );
    assert.ok(
      (
        await runArtwork(target, { ...clean, records: [] }, "verify")
      ).conflicts.some((c) => c.reason === "unexpected_mapping"),
    );
    await assert.rejects(
      target.query("SELECT jpegpe.import_artwork($1,'image/png',false,$2)", [
        record.id,
        Buffer.from([1]),
      ]),
      { code: "23505" },
    );
    await assert.rejects(
      admin.query("DELETE FROM jpegpe.artwork"),
      /immutable/,
    );
  } finally {
    await fixture.cleanup();
  }
}
