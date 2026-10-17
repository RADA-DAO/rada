import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "../../modules/splash/png.ts";
import { bucket, digest, type ManifestObject } from "./artwork-files.ts";
export async function artworkFixture() {
  const root = await mkdtemp(join(tmpdir(), "rada-artwork-synthetic-"));
  const bytes = encodePng({
    width: 64,
    height: 64,
    rgba: new Uint8Array(64 * 64 * 4).fill(127),
  });
  await mkdir(join(root, bucket, "123"), { recursive: true });
  const objects: ManifestObject[] = [];
  for (const name of [
    "good.png",
    "missing.png",
    "mismatch.png",
    "unsupported.webp",
  ]) {
    const key = `123/${name}`;
    const data = name.endsWith("webp")
      ? Buffer.from("RIFFsyntheticWEBP")
      : bytes;
    objects.push({
      bucket,
      key,
      metadata: {
        size: data.length,
        mimetype: name.endsWith("webp") ? "image/webp" : "image/png",
        eTag: name === "mismatch.png" ? "0".repeat(32) : digest(data, "md5"),
      },
    });
    if (name !== "missing.png") await writeFile(join(root, bucket, key), data);
  }
  const manifest = join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ buckets: [bucket], objects }));
  return {
    root,
    manifest,
    objects,
    bytes,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
