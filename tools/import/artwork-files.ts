import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import {
  decodePng,
  encodePng,
  pngDimensions,
} from "../../modules/splash/index.ts";
import type { ArtworkImage } from "../../modules/jpegpe/index.ts";
export const bucket = "jpegpe-frog-images";
const limit = 2 * 1024 * 1024;
export const digest = (bytes: Uint8Array, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");
export interface ManifestObject {
  bucket: string;
  key: string;
  metadata: { size: number; mimetype: string; eTag: string };
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
    result.set(o.key, { ...o, metadata: o.metadata });
  }
  return result;
}
// No JPEG decoder exists in the dependency set. Validate its bounded marker stream,
// dimensions and complete scan envelope, then quarantine the original for normalization.
function checkJpeg(bytes: Buffer) {
  if (
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
  if (width < 64 || height < 64 || width > 1024 || height > 1024)
    throw new Error("bad_dimensions");
}
export async function prepareArtwork(
  root: string,
  object: ManifestObject,
): Promise<ArtworkImage & { sourceSha256: string }> {
  const { key, metadata: m } = object;
  if (
    object.bucket !== bucket ||
    key.split("/").some((p) => !p || p === "." || p === "..") ||
    key.includes("\\") ||
    key.includes("\0")
  )
    throw new Error("unsafe_path");
  const base = await realpath(root);
  let path = base;
  for (const part of [bucket, ...key.split("/")]) {
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
  if (digest(bytes, "md5") !== m.eTag.replaceAll('"', "").toLowerCase())
    throw new Error("checksum_mismatch");
  const sourceSha256 = digest(bytes);
  if (m.mimetype === "image/png" && extname(key).toLowerCase() === ".png") {
    try {
      const { width, height } = pngDimensions(bytes);
      dimensions(width, height);
      const normalized = encodePng(decodePng(bytes));
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
      throw new Error("invalid_image", { cause: error });
    }
  }
  if (
    m.mimetype === "image/jpeg" &&
    [".jpg", ".jpeg"].includes(extname(key).toLowerCase()) &&
    bytes.length >= 4
  ) {
    checkJpeg(bytes);
    return {
      bytes,
      contentType: "image/jpeg",
      needsNormalization: true,
      sourceSha256,
    };
  }
  throw new Error("unsupported_type");
}
