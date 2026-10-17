import test from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { artworkFixture } from "./artwork-fixture.ts";
import {
  bucket,
  prepareArtwork,
  readManifest,
  readJournal,
  digest,
  downscale,
  InvalidArtwork,
} from "./artwork-files.ts";
await test("synthetic manifest, normalization, missing, corrupt, unsupported and unsafe files", async () => {
  const fixture = await artworkFixture();
  try {
    const objects = await readManifest(fixture.manifest);
    const get = (key: string) => {
      const value = objects.get(key);
      assert.ok(value);
      return value;
    };
    const good = get("123/good.png");
    const image = await prepareArtwork(fixture.root, good);
    assert.equal(image.needsNormalization, false);
    assert.deepEqual(image.bytes, fixture.bytes);
    await assert.rejects(prepareArtwork(fixture.root, get("123/missing.png")), {
      code: "ENOENT",
    });
    await assert.rejects(
      prepareArtwork(fixture.root, get("123/mismatch.png")),
      /checksum_mismatch/,
    );
    await assert.rejects(
      prepareArtwork(fixture.root, get("123/unsupported.webp")),
      /unsupported_type/,
    );
    await assert.rejects(
      prepareArtwork(fixture.root, { ...good, key: "../escape.png" }),
      /unsafe_path/,
    );
    await symlink(
      join(fixture.root, bucket, good.key),
      join(fixture.root, bucket, "link.png"),
    );
    await assert.rejects(
      prepareArtwork(fixture.root, { ...good, key: "link.png" }),
      /unsafe_path/,
    );
    await assert.rejects(
      prepareArtwork(fixture.root, {
        ...good,
        metadata: { ...good.metadata, size: 1 },
      }),
      /size_mismatch/,
    );
    await writeFile(
      fixture.manifest,
      JSON.stringify({ buckets: [], objects: [good, good] }),
    );
    await assert.rejects(readManifest(fixture.manifest), /invalid_manifest/);
  } finally {
    await fixture.cleanup();
  }
});

await test("bounded PNG decoding and explicitly pending JPEG envelopes", async () => {
  const fixture = await artworkFixture();
  try {
    const { digest } = await import("./artwork-files.ts");
    const prepare = async (
      data: Buffer,
      extension = "png",
      mimetype = "image/png",
    ) => {
      const key = `123/edge.${extension}`;
      await writeFile(join(fixture.root, bucket, key), data);
      return prepareArtwork(fixture.root, {
        bucket,
        key,
        metadata: { size: data.length, mimetype, eTag: digest(data, "md5") },
      });
    };
    const oversized = Buffer.from(fixture.bytes);
    oversized.writeUInt32BE(8193, 16);
    await assert.rejects(prepare(oversized), /bad_dimensions/);
    const corrupt = Buffer.from(fixture.bytes);
    corrupt[40] = (corrupt[40] ?? 0) ^ 255;
    await assert.rejects(prepare(corrupt), /invalid_image/);
    await assert.rejects(
      prepare(Buffer.alloc(8 * 1024 * 1024 + 1)),
      /too_large/,
    );
    // Deliberately synthetic marker envelope, not a claim of JPEG pixel validity.
    const jpeg = Buffer.from([
      255, 216, 255, 192, 0, 11, 8, 0, 64, 0, 64, 1, 1, 17, 0, 255, 218, 0, 8,
      1, 1, 0, 0, 63, 0, 1, 2, 3, 255, 217,
    ]);
    const pending = await prepare(jpeg, "jpg", "image/jpeg");
    assert.equal(pending.needsNormalization, true);
    assert.deepEqual(pending.bytes, jpeg);
    await assert.rejects(prepare(jpeg, "png"), /invalid_image/);
    await assert.rejects(
      prepare(jpeg.subarray(0, jpeg.length - 1), "jpg", "image/jpeg"),
      /invalid_image/,
    );
    const largeJpeg = Buffer.from(jpeg);
    largeJpeg.writeUInt16BE(1025, 9);
    assert.deepEqual(
      (await prepare(largeJpeg, "jpg", "image/jpeg")).bytes,
      largeJpeg,
    );
    for (const side of [31, 8193]) {
      largeJpeg.writeUInt16BE(side, 9);
      await assert.rejects(
        prepare(largeJpeg, "jpg", "image/jpeg"),
        /bad_dimensions/,
      );
    }
    largeJpeg.writeUInt16BE(8192, 9);
    assert.equal(
      (await prepare(largeJpeg, "jpg", "image/jpeg")).needsNormalization,
      true,
    );
    const hugeJpeg = Buffer.concat([
      jpeg.subarray(0, -2),
      Buffer.alloc(4 * 1024 * 1024),
      jpeg.subarray(-2),
    ]);
    await assert.rejects(prepare(hugeJpeg, "jpg", "image/jpeg"), /too_large/);
  } finally {
    await fixture.cleanup();
  }
});

await test("CLI refuses without isolated restore acknowledgement before accessing data", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--no-warnings",
      fileURLToPath(new URL("main.ts", import.meta.url)),
      "dry-run",
    ],
    { env: {}, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IMPORT_ISOLATED_RESTORE=yes required/);
});

await test("large PNG inputs downscale within storage bounds and preserve alpha and aspect", async () => {
  const { randomFillSync } = await import("node:crypto");
  const { encodePng, decodePng } = await import("../../modules/splash/png.ts");
  const fixture = await artworkFixture();
  try {
    const rgba = randomFillSync(new Uint8Array(1536 * 768 * 4));
    const bytes = encodePng({ width: 1536, height: 768, rgba });
    assert.ok(bytes.length > 2 * 1024 * 1024 && bytes.length < 8 * 1024 * 1024);
    const key = "123/large.png";
    await writeFile(join(fixture.root, bucket, key), bytes);
    const image = await prepareArtwork(fixture.root, {
      bucket,
      key,
      metadata: {
        size: bytes.length,
        mimetype: "image/png",
        eTag: digest(bytes, "md5"),
      },
    });
    assert.ok(image.bytes.length <= 4 * 1024 * 1024);
    const raster = decodePng(image.bytes);
    assert.equal(raster.width, 1024);
    assert.equal(raster.height, 512);
    assert.equal(image.sourceSha256, digest(bytes));
    for (const side of [31, 32, 8192, 8193]) {
      const data = encodePng({
        width: side,
        height: 32,
        rgba: new Uint8Array(side * 32 * 4).fill(127),
      });
      await writeFile(join(fixture.root, bucket, key), data);
      const promise = prepareArtwork(fixture.root, {
        bucket,
        key,
        metadata: {
          size: data.length,
          mimetype: "image/png",
          eTag: digest(data, "md5"),
        },
      });
      if (side === 31 || side === 8193)
        await assert.rejects(promise, /bad_dimensions/);
      else assert.ok((await promise).bytes.length);
    }
    const bomb = Buffer.from(fixture.bytes);
    bomb.writeUInt32BE(8193, 16);
    bomb.writeUInt32BE(8192, 20);
    assert.throws(() => decodePng(bomb), /memory_bound/);
  } finally {
    await fixture.cleanup();
  }
});

await test("area averaging weights fractional coverage and premultiplies alpha", () => {
  const rgba = new Uint8Array(1536 * 32 * 4);
  for (let i = 0; i < rgba.length; i += 4)
    rgba.set((i / 4) % 2 ? [0, 0, 255, 0] : [255, 0, 0, 255], i);
  const raster = downscale({ width: 1536, height: 32, rgba });
  assert.equal(raster.width, 1024);
  assert.equal(raster.height, 21);
  assert.deepEqual(
    [...raster.rgba.slice(0, 8)],
    [255, 0, 0, 170, 255, 0, 0, 170],
  );
  assert.deepEqual(
    [
      ...downscale({
        width: 2048,
        height: 64,
        rgba: new Uint8Array(2048 * 64 * 4),
      }).rgba.slice(0, 4),
    ],
    [0, 0, 0, 0],
  );
});

await test("journal overlays latest put, verifies blobs, and rejects unsafe or malformed entries", async () => {
  const fixture = await artworkFixture();
  try {
    const journal = join(fixture.root, "journal.jsonl"),
      blobs = join(fixture.root, "blobs");
    await mkdir(blobs);
    const sha256 = digest(fixture.bytes),
      key = "123/journal.png";
    await writeFile(join(blobs, sha256), fixture.bytes);
    const object = {
      bucket,
      key,
      sha256,
      metadata: { size: fixture.bytes.length, mimetype: "image/png" },
    };
    const put = (o: typeof object) =>
      JSON.stringify({ op: "put", key: `${o.bucket}/${o.key}`, object: o });
    await writeFile(
      journal,
      [put({ ...object, sha256: "0".repeat(64) }), put(object), ""].join("\n"),
    );
    const objects = await readManifest(fixture.manifest);
    await readJournal(journal, objects);
    assert.equal(objects.get(key)?.sha256, sha256);
    const latest = objects.get(key);
    assert.ok(latest);
    assert.deepEqual(
      (await prepareArtwork("", latest, blobs)).bytes,
      fixture.bytes,
    );
    await assert.rejects(
      prepareArtwork("", { ...object, key: "../escape.png" }, blobs),
      /unsafe_path/,
    );
    await assert.rejects(
      prepareArtwork("", { ...object, sha256: "1".repeat(64) }, blobs),
      { code: "ENOENT" },
    );
    await writeFile(join(blobs, sha256), new Uint8Array(fixture.bytes.length));
    await assert.rejects(
      prepareArtwork("", object, blobs),
      /checksum_mismatch/,
    );
    await symlink(join(blobs, sha256), join(blobs, "2".repeat(64)));
    await assert.rejects(
      prepareArtwork("", { ...object, sha256: "2".repeat(64) }, blobs),
      /unsafe_path/,
    );
    for (const entry of [
      "{",
      JSON.stringify({ op: "put", key: "wrong", object }),
      put({ ...object, sha256: "../escape" }),
    ]) {
      await writeFile(journal, entry);
      await assert.rejects(readJournal(journal, objects));
    }
  } finally {
    await fixture.cleanup();
  }
});

await test("planner uses journal-only sources and reports fixed detected types with hashed keys", async () => {
  const { planArtwork, runArtwork } = await import("./artwork.ts");
  const { hash } = await import("./model.ts");
  const fixture = await artworkFixture();
  try {
    const journal = join(fixture.root, "journal.jsonl"),
      blobs = join(fixture.root, "blobs");
    await mkdir(blobs);
    const bytes = Buffer.from("GIF89a private synthetic data"),
      sha256 = digest(bytes);
    await writeFile(join(blobs, sha256), bytes);
    const object = {
      bucket,
      key: "private/path.png",
      sha256,
      metadata: { size: bytes.length, mimetype: "image/png" },
    };
    await writeFile(
      journal,
      JSON.stringify({ op: "put", key: `${bucket}/${object.key}`, object }),
    );
    const source = {
      query: () =>
        Promise.resolve({
          rows: [{ id: "private-id", storage_path: object.key }],
        }),
    } as unknown as import("pg").Client;
    const snapshot = {
      records: [{ entity: "frogs", id: "private-id" }],
    } as import("./model.ts").Snapshot;
    const plan = await planArtwork(
      source,
      snapshot,
      "",
      undefined,
      journal,
      blobs,
    );
    assert.deepEqual(plan.conflicts, [
      {
        entity: "artwork",
        key: "private-id",
        reason: "invalid_image",
        detected_type: "gif",
      },
    ]);
    const target = {
      query: () => Promise.resolve({ rows: [] }),
    } as unknown as import("pg").Client;
    const report = await runArtwork(target, plan, "dry-run");
    assert.equal(report.conflicts[0]?.key, hash("private-id"));
    assert.equal(report.conflicts[0].detected_type, "gif");
    assert.doesNotMatch(JSON.stringify(report), /private/);
    assert.equal(
      new InvalidArtwork(Buffer.from("private bytes"), null).detectedType,
      "unknown",
    );
    const goodSha = digest(fixture.bytes);
    await writeFile(join(blobs, goodSha), fixture.bytes);
    const good = {
      ...object,
      sha256: goodSha,
      metadata: { ...object.metadata, size: fixture.bytes.length },
    };
    await writeFile(
      journal,
      JSON.stringify({
        op: "put",
        key: `${bucket}/${object.key}`,
        object: good,
      }),
    );
    const ready = await planArtwork(
      source,
      snapshot,
      "",
      undefined,
      journal,
      blobs,
    );
    assert.equal(ready.records.length, 1);
    assert.equal(ready.conflicts.length, 0);
  } finally {
    await fixture.cleanup();
  }
});
