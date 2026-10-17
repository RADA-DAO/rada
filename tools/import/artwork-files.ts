import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import {
  decodePng,
  encodePng,
  pngDimensions,
  type Raster,
} from "../../modules/splash/png.ts";
import type { ArtworkImage } from "../../modules/jpegpe/storage.ts";
export const bucket = "jpegpe-frog-images";
const limit = 8 * 1024 * 1024;
export const digest = (bytes: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
export interface ManifestObject {
  bucket: string;
  key: string;
  metadata: { size: number; mimetype: string; eTag?: string };
  sha256?: string;
}
export async function readManifest(
  path: string,
): Promise<Map<string, ManifestObject>> {
  const data = JSON.parse(await readFile(path, "utf8")) as {
    buckets: unknown[];
    objects: (Omit<ManifestObject, "metadata"> & {
      metadata: ManifestObject["metadata"] | null;
    })[];
  };
  if (!Array.isArray(data.buckets) || !Array.isArray(data.objects))
    throw new Error("invalid_manifest");
  const result = new Map<string, ManifestObject>();
  for (const o of data.objects) {
    if (o.bucket !== bucket) continue;
    if (
      typeof o.key !== "string" ||
      result.has(o.key) ||
      typeof o.metadata !== "object" ||
      o.metadata === null ||
      !Number.isSafeInteger(o.metadata.size) ||
      o.metadata.size < 1 ||
      typeof o.metadata.mimetype !== "string" ||
      typeof o.metadata.eTag !== "string" ||
      !/^(?:[a-fA-F0-9]{32}|"[a-fA-F0-9]{32}")$/.test(o.metadata.eTag)
    )
      throw new Error("invalid_manifest");
    result.set(o.key, { bucket: o.bucket, key: o.key, metadata: o.metadata });
  }
  return result;
}
// No JPEG decoder exists in the dependency set. Validate its bounded marker stream,
// dimensions and complete scan envelope, then quarantine the original for normalization.
function checkJpeg(bytes: Buffer) {
  if (
    bytes.length < 4 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    throw new Error("invalid_image");
  let at = 2,
    frame = false;
  while (at < bytes.length - 2) {
    if (bytes[at++] !== 255) throw new Error("invalid_image");
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (at + 2 > bytes.length) throw new Error("invalid_image");
    const size = bytes.readUInt16BE(at);
    if (size < 2 || at + size > bytes.length - 2)
      throw new Error("invalid_image");
    if (marker === 0xc0 || marker === 0xc2) {
      if (frame || size < 11 || bytes[at + 2] !== 8)
        throw new Error("invalid_image");
      dimensions(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3));
      frame = true;
    } else if (marker === 0xda) {
      if (!frame || size < 6 || at + size >= bytes.length - 2)
        throw new Error("invalid_image");
      return;
    } else if (
      marker === undefined ||
      (![0xc4, 0xdb, 0xdd, 0xfe].includes(marker) &&
        !(marker >= 0xe0 && marker <= 0xef))
    ) {
      throw new Error("unsupported_type");
    }
    at += size;
  }
  throw new Error("invalid_image");
}
function dimensions(width: number, height: number) {
  if (width < 32 || height < 32 || width > 8192 || height > 8192)
    throw new Error("bad_dimensions");
}
export async function prepareArtwork(
  root: string,
  object: ManifestObject,
  blobs?: string,
): Promise<ArtworkImage & { sourceSha256: string }> {
  const { key, metadata: m } = object;
  if (
    object.bucket !== bucket ||
    key.split("/").some((p) => !p || p === "." || p === "..") ||
    key.includes("\\") ||
    key.includes("\0")
  )
    throw new Error("unsafe_path");
  if (object.sha256 && (!blobs || !/^[a-f0-9]{64}$/.test(object.sha256)))
    throw new Error("invalid_journal");
  const base = await realpath(object.sha256 ? (blobs ?? "") : root);
  let path = base;
  for (const part of object.sha256
    ? [object.sha256]
    : [bucket, ...key.split("/")]) {
    path = resolve(path, part);
    if (!path.startsWith(base + sep) || (await lstat(path)).isSymbolicLink())
      throw new Error("unsafe_path");
  }
  const stat = await lstat(path);
  if (!stat.isFile()) throw new Error("unsafe_path");
  if (stat.size > limit || m.size > limit) throw new Error("too_large");
  if (stat.size !== m.size) throw new Error("size_mismatch");
  const bytes = await readFile(path);
  if (bytes.length !== m.size) throw new Error("size_mismatch");
  if (
    object.sha256
      ? digest(bytes) !== object.sha256
      : digest(bytes, "md5") !== m.eTag?.replaceAll('"', "").toLowerCase()
  )
    throw new Error("checksum_mismatch");
  const sourceSha256 = digest(bytes);
  if (m.mimetype === "image/png" && extname(key).toLowerCase() === ".png") {
    try {
      const { width, height } = pngDimensions(bytes);
      dimensions(width, height);
      const normalized = encodePng(downscale(decodePng(bytes)));
      if (normalized.length > 4 * 1024 * 1024) throw new Error("too_large");
      return {
        bytes: normalized,
        contentType: "image/png",
        needsNormalization: false,
        sourceSha256,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        ["bad_dimensions", "too_large"].includes(error.message)
      )
        throw error;
      throw new InvalidArtwork(bytes, error);
    }
  }
  if (
    m.mimetype === "image/jpeg" &&
    [".jpg", ".jpeg"].includes(extname(key).toLowerCase())
  ) {
    try {
      checkJpeg(bytes);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_image")
        throw new InvalidArtwork(bytes, error);
      throw error;
    }
    if (bytes.length > 4 * 1024 * 1024) throw new Error("too_large");
    return {
      bytes,
      contentType: "image/jpeg",
      needsNormalization: true,
      sourceSha256,
    };
  }
  throw new Error("unsupported_type");
}

// Only fixed signature labels are reported; arbitrary prefix bytes could be private text.
export class InvalidArtwork extends Error {
  detectedType: string;
  constructor(bytes: Uint8Array, cause: unknown) {
    super("invalid_image", { cause });
    const hex = Buffer.from(bytes.subarray(0, 12)).toString("hex");
    this.detectedType = hex.startsWith("89504e470d0a1a0a")
      ? "png"
      : hex.startsWith("ffd8")
        ? "jpeg"
        : hex.startsWith("474946383761") || hex.startsWith("474946383961")
          ? "gif"
          : hex.startsWith("52494646") && hex.endsWith("57454250")
            ? "webp"
            : "unknown";
  }
}

/** Box/area averaging in premultiplied alpha, including fractional edge coverage. */
export function downscale(source: Raster): Raster {
  const scale = Math.min(1, 1024 / Math.max(source.width, source.height));
  if (scale === 1) return source;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const rgba = new Uint8Array(width * height * 4);
  const sx = source.width / width,
    sy = source.height / height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const left = x * sx,
        right = (x + 1) * sx;
      const top = y * sy,
        bottom = (y + 1) * sy;
      let alpha = 0,
        red = 0,
        green = 0,
        blue = 0;
      for (let iy = Math.floor(top); iy < Math.ceil(bottom); iy++) {
        for (let ix = Math.floor(left); ix < Math.ceil(right); ix++) {
          const weight =
            (Math.min(right, ix + 1) - Math.max(left, ix)) *
            (Math.min(bottom, iy + 1) - Math.max(top, iy));
          const at = (iy * source.width + ix) * 4;
          const a = (source.rgba[at + 3] ?? 0) * weight;
          alpha += a;
          red += (source.rgba[at] ?? 0) * a;
          green += (source.rgba[at + 1] ?? 0) * a;
          blue += (source.rgba[at + 2] ?? 0) * a;
        }
      }
      const at = (y * width + x) * 4;
      rgba[at] = alpha ? Math.round(red / alpha) : 0;
      rgba[at + 1] = alpha ? Math.round(green / alpha) : 0;
      rgba[at + 2] = alpha ? Math.round(blue / alpha) : 0;
      rgba[at + 3] = Math.round(alpha / (sx * sy));
    }
  }
  return { width, height, rgba };
}

/** The journal overlays the frozen manifest; the last put for each key wins. */
export async function readJournal(
  path: string,
  objects: Map<string, ManifestObject>,
) {
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as {
      op: string;
      key: string;
      object?: Omit<ManifestObject, "metadata"> & {
        metadata?: ManifestObject["metadata"] | null;
      };
    };
    if (entry.op === "delete" && typeof entry.key === "string") {
      // A later delete removes the object; an earlier put no longer applies.
      objects.delete(entry.key.slice(entry.key.indexOf("/") + 1));
      continue;
    }
    if (entry.op !== "put") throw new Error("invalid_journal");
    const o = entry.object;
    if (
      !o ||
      typeof o.bucket !== "string" ||
      typeof o.key !== "string" ||
      entry.key !== `${o.bucket}/${o.key}` ||
      typeof o.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(o.sha256) ||
      !o.metadata ||
      !Number.isSafeInteger(o.metadata.size) ||
      o.metadata.size < 1 ||
      typeof o.metadata.mimetype !== "string"
    )
      throw new Error("invalid_journal");
    if (o.bucket === bucket)
      objects.set(o.key, {
        bucket: o.bucket,
        key: o.key,
        sha256: o.sha256,
        metadata: o.metadata,
      });
  }
}
