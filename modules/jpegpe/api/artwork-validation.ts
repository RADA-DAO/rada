import { pngDimensions } from "../../splash/png.ts";
import type { ArtworkImage } from "./storage.ts";

/** Storage is bounded to 4 MiB. No MIME guessing or active document formats. */
export function validArtwork(image: ArtworkImage): boolean {
  const b = image.bytes;
  if (!b.length || b.length > 4 * 1024 * 1024) return false;
  if (image.contentType === "image/png" && !image.needsNormalization) {
    try {
      const { width, height } = pngDimensions(b);
      return (
        width > 0 &&
        height > 0 &&
        width <= 8192 &&
        height <= 8192 &&
        b.length >= 45 &&
        [...b.slice(-12, -4)].join(",") === "0,0,0,0,73,69,78,68"
      );
    } catch {
      return false;
    }
  }
  return (
    image.contentType === "image/jpeg" &&
    image.needsNormalization &&
    validJpeg(b)
  );
}

/** Validate the complete marker/scan envelope; this does not decode JPEG pixels. */
function validJpeg(b: Uint8Array): boolean {
  if (b[0] !== 255 || b[1] !== 216) return false;
  let at = 2,
    frame = false,
    scan = false,
    entropy = false;
  const word = (i: number) => (b[i]! << 8) | b[i + 1]!;
  while (at < b.length) {
    if (entropy) {
      while (at < b.length && b[at] !== 255) at++;
    }
    if (b[at++] !== 255) return false;
    while (b[at] === 255) at++;
    const marker = b[at++];
    if (
      entropy &&
      (marker === 0 || (marker !== undefined && marker >= 208 && marker <= 215))
    )
      continue;
    entropy = false;
    if (marker === 217) return frame && scan && at === b.length;
    if (at + 2 > b.length) return false;
    const size = word(at);
    if (size < 2 || at + size > b.length) return false;
    if (marker === 192 || marker === 194) {
      const channels = b[at + 7];
      if (
        frame ||
        size < 11 ||
        b[at + 2] !== 8 ||
        !channels ||
        ![1, 3, 4].includes(channels) ||
        size !== 8 + 3 * channels ||
        !word(at + 3) ||
        !word(at + 5) ||
        word(at + 3) > 8192 ||
        word(at + 5) > 8192
      )
        return false;
      frame = true;
    } else if (marker === 218) {
      const channels = b[at + 2];
      if (
        !frame ||
        !channels ||
        channels > 4 ||
        size !== 6 + 2 * channels ||
        at + size >= b.length - 2
      )
        return false;
      scan = true;
      entropy = true;
    } else if (
      marker === undefined ||
      (![196, 219, 221, 254].includes(marker) &&
        !(marker >= 224 && marker <= 239))
    )
      return false;
    at += size;
  }
  return false;
}
