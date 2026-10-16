import type { Raster } from "./png.ts";

export type Cutout = { removed: boolean; raster: Raster };

const TRANSPARENT_BELOW = 32;
const SOLID_CORNER_DISTANCE = 18;
const FULL_CUT_DISTANCE = 22;
const KEEP_DISTANCE = 38;
const VISIBLE_ALPHA = 24;

/**
 * Removes a solid background by flooding inwards from the image border and
 * recentres the frog on a square canvas. This is a port of the SPLASH client
 * algorithm (same thresholds), run on the server so the stored result never
 * depends on what a client claims it did.
 *
 * - If the four corners are not all transparent or all within a small distance
 *   of their average colour, the background is not solid: nothing is removed.
 * - Border pixels close to the background colour become transparent; pixels in
 *   a narrow band beyond it get partial alpha (soft edge); the fill stops at
 *   anything further away.
 */
export function cutSolidBackground(input: Raster): Cutout {
  const { width, height } = input;
  const pixels = Uint8Array.from(input.rgba);
  const at = (index: number, channel: number) =>
    pixels[index * 4 + channel] ?? 0;
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const background = [0, 1, 2].map(
    (channel) =>
      corners.reduce((sum, index) => sum + at(index, channel), 0) /
      corners.length,
  );
  const distance = (index: number) =>
    Math.hypot(
      at(index, 0) - (background[0] ?? 0),
      at(index, 1) - (background[1] ?? 0),
      at(index, 2) - (background[2] ?? 0),
    );
  const transparentBoundary = corners.every(
    (index) => at(index, 3) < TRANSPARENT_BELOW,
  );
  if (
    !transparentBoundary &&
    corners.some((index) => distance(index) > SOLID_CORNER_DISTANCE)
  )
    return { removed: false, raster: input };

  const queued = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let read = 0;
  let write = 0;
  const add = (index: number) => {
    if (queued[index]) return;
    queued[index] = 1;
    queue[write++] = index;
  };
  for (let x = 0; x < width; x++) {
    add(x);
    add((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y++) {
    add(y * width);
    add(y * width + width - 1);
  }
  let removed = false;
  while (read < write) {
    const index = queue[read++] ?? 0;
    const colourDistance = distance(index);
    const sourceAlpha = at(index, 3);
    if (sourceAlpha >= TRANSPARENT_BELOW && colourDistance > KEEP_DISTANCE)
      continue;
    const alpha =
      sourceAlpha < TRANSPARENT_BELOW || colourDistance <= FULL_CUT_DISTANCE
        ? 0
        : Math.round(
            (255 * (colourDistance - FULL_CUT_DISTANCE)) /
              (KEEP_DISTANCE - FULL_CUT_DISTANCE),
          );
    pixels[index * 4 + 3] = alpha;
    removed ||= alpha < 255;
    const x = index % width;
    if (x > 0) add(index - 1);
    if (x < width - 1) add(index + 1);
    if (index >= width) add(index - width);
    if (index < width * (height - 1)) add(index + width);
  }
  if (!removed) return { removed: false, raster: input };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (at(y * width + x, 3) < VISIBLE_ALPHA) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  if (maxX < minX || maxY < minY)
    return { removed: true, raster: { width, height, rgba: pixels } };

  // Square canvas: 6% side margin, bottom-aligned with a 2% base margin.
  const contentWidth = maxX - minX + 1;
  const contentHeight = maxY - minY + 1;
  const side = Math.ceil(Math.max(contentWidth / 0.88, contentHeight / 0.94));
  const targetX = Math.round((side - contentWidth) / 2);
  const targetY = Math.max(0, Math.round(side - contentHeight - side * 0.02));
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < contentHeight; y++) {
    const row = pixels.subarray(
      ((minY + y) * width + minX) * 4,
      ((minY + y) * width + minX + contentWidth) * 4,
    );
    const destination = ((targetY + y) * side + targetX) * 4;
    if (targetY + y < side) out.set(row, destination);
  }
  return { removed: true, raster: { width: side, height: side, rgba: out } };
}
