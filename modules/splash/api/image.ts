import { createHash } from "node:crypto";
import { cutSolidBackground } from "./cutout.ts";
import { decodePng, encodePng, InvalidPng, pngDimensions } from "./png.ts";

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_STORED_BYTES = 4 * 1024 * 1024;
export const MIN_SOURCE_SIDE = 64;
export const MAX_SOURCE_SIDE = 1024;
const MIN_RESULT_SIDE = 32;

export type RejectionCode =
  "too_large" | "unsupported_type" | "bad_dimensions" | "invalid_image";

export class SubmissionRejected extends Error {
  code: RejectionCode;
  constructor(code: RejectionCode) {
    super(code);
    this.code = code;
  }
}

export type PreparedImage = {
  bytes: Uint8Array;
  sha256: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
};

/**
 * Validates an uploaded PNG and produces the image that will be stored.
 * The image is always decoded and re-encoded, so metadata chunks never reach
 * storage, and the background cut is computed here from pixels, not trusted.
 */
export function prepareImage(upload: Uint8Array): PreparedImage {
  if (upload.length > MAX_UPLOAD_BYTES)
    throw new SubmissionRejected("too_large");
  let header: { width: number; height: number };
  try {
    header = pngDimensions(upload);
  } catch {
    throw new SubmissionRejected("unsupported_type");
  }
  const inRange = (side: number) =>
    side >= MIN_SOURCE_SIDE && side <= MAX_SOURCE_SIDE;
  if (!inRange(header.width) || !inRange(header.height))
    throw new SubmissionRejected("bad_dimensions");
  let cutout;
  try {
    cutout = cutSolidBackground(decodePng(upload));
  } catch (error) {
    if (error instanceof InvalidPng)
      throw new SubmissionRejected("invalid_image");
    throw error;
  }
  const { width, height } = cutout.raster;
  if (width < MIN_RESULT_SIDE || height < MIN_RESULT_SIDE)
    throw new SubmissionRejected("bad_dimensions");
  const bytes = encodePng(cutout.raster);
  if (bytes.length > MAX_STORED_BYTES)
    throw new SubmissionRejected("too_large");
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width,
    height,
    backgroundRemoved: cutout.removed,
  };
}
