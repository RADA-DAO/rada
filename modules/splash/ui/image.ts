/** Server limits for a submission (see the module README). */
export const MAX_SIDE = 1024;
export const MIN_SIDE = 64;
export const MAX_BYTES = 2 * 1024 * 1024;
export const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp";

/** Size that fits inside `max` on the longer side, never enlarging. */
export function fitWithin(
  width: number,
  height: number,
  max = MAX_SIDE,
): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Why an image cannot be prepared; each code has a translated message. */
export type PrepareFailure = "unsupported" | "too_small" | "too_large";
export class PrepareError extends Error {
  readonly code: PrepareFailure;
  constructor(code: PrepareFailure) {
    super(code);
    this.code = code;
  }
}

/**
 * Converts a chosen picture to a PNG the server accepts: at most 1024 px per
 * side and 2 MiB. A PNG that is still too large is scaled down further.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!ACCEPTED_TYPES.split(",").includes(file.type))
    throw new PrepareError("unsupported");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PrepareError("unsupported");
  }
  try {
    let max = MAX_SIDE;
    for (let attempt = 0; attempt < 6; attempt++) {
      const size = fitWithin(bitmap.width, bitmap.height, max);
      if (Math.min(size.width, size.height) < MIN_SIDE)
        throw new PrepareError(attempt ? "too_large" : "too_small");
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context) throw new PrepareError("unsupported");
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, "image/png");
      });
      if (!blob) throw new PrepareError("unsupported");
      if (blob.size <= MAX_BYTES) return blob;
      max = Math.floor(Math.max(size.width, size.height) * 0.8);
    }
    throw new PrepareError("too_large");
  } finally {
    bitmap.close();
  }
}
