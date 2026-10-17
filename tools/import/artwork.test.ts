import test from "node:test";
import assert from "node:assert/strict";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { artworkFixture } from "./artwork-fixture.ts";
import { bucket, prepareArtwork, readManifest } from "./artwork-files.ts";
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
    oversized.writeUInt32BE(1025, 16);
    await assert.rejects(prepare(oversized), /bad_dimensions/);
    const corrupt = Buffer.from(fixture.bytes);
    corrupt[40] = (corrupt[40] ?? 0) ^ 255;
    await assert.rejects(prepare(corrupt), /invalid_image/);
    await assert.rejects(
      prepare(Buffer.alloc(2 * 1024 * 1024 + 1)),
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
    await assert.rejects(
      prepare(largeJpeg, "jpg", "image/jpeg"),
      /bad_dimensions/,
    );
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
      "--experimental-transform-types",
      "--no-warnings",
      fileURLToPath(new URL("main.ts", import.meta.url)),
      "dry-run",
    ],
    { env: {}, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IMPORT_ISOLATED_RESTORE=yes required/);
});
