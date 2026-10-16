import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { cutSolidBackground } from "./cutout.ts";
import { prepareImage, SubmissionRejected } from "./image.ts";
import { decodePng, encodePng } from "./png.ts";

function raster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, rgba };
}
/** A red 40x40 block on a solid light-grey background. */
const frog = (width = 120, height = 100) =>
  raster(width, height, (x, y) =>
    x >= 40 && x < 80 && y >= 30 && y < 70
      ? [200, 30, 30, 255]
      : [235, 235, 235, 255],
  );
const rejects = (input: Uint8Array, code: string) =>
  assert.throws(
    () => prepareImage(input),
    (error) => error instanceof SubmissionRejected && error.code === code,
  );
/** Re-chunks a PNG with a custom header / extra chunk, recomputing no checksums on purpose. */
function withBytes(png: Uint8Array, edit: (copy: Uint8Array) => void) {
  const copy = Uint8Array.from(png);
  edit(copy);
  return copy;
}

test("PNG codec round-trips RGBA exactly", () => {
  const source = raster(70, 66, (x, y) => [x, y, (x * y) & 255, 255 - x]);
  const decoded = decodePng(encodePng(source));
  assert.equal(decoded.width, 70);
  assert.deepEqual(decoded.rgba, source.rgba);
});

test("solid background is cut, the frog is centred on a square canvas", () => {
  const prepared = prepareImage(encodePng(frog()));
  assert.equal(prepared.backgroundRemoved, true);
  assert.equal(prepared.width, prepared.height);
  const out = decodePng(prepared.bytes);
  const alpha = (x: number, y: number) => out.rgba[(y * out.width + x) * 4 + 3];
  assert.equal(alpha(0, 0), 0);
  assert.equal(alpha(out.width - 1, 0), 0);
  // The block keeps its opaque colour at the canvas centre horizontally.
  const middle = Math.floor(out.width / 2);
  assert.equal(alpha(middle, out.height - Math.ceil(out.height * 0.1)), 255);
  assert.match(prepared.sha256, /^[0-9a-f]{64}$/);
});

test("an already transparent image keeps its subject", () => {
  const transparent = raster(100, 100, (x, y) =>
    x >= 30 && x < 70 && y >= 30 && y < 70 ? [10, 200, 10, 255] : [0, 0, 0, 0],
  );
  const result = cutSolidBackground(transparent);
  assert.equal(result.removed, true);
  assert.equal(result.raster.width, result.raster.height);
});

test("a busy background is left untouched and reported as not removed", () => {
  const busy = raster(100, 100, (x, y) => [
    (x * 7) & 255,
    (y * 11) & 255,
    ((x + y) * 3) & 255,
    255,
  ]);
  const prepared = prepareImage(encodePng(busy));
  assert.equal(prepared.backgroundRemoved, false);
  assert.deepEqual(decodePng(prepared.bytes).rgba, busy.rgba);
});

test("metadata chunks are dropped by re-encoding", () => {
  const png = encodePng(frog());
  // Insert a tEXt chunk after IHDR (chunk bytes: length, type, body, crc).
  const text = new TextEncoder().encode("Authorsecret@example.com");
  const chunk = new Uint8Array(12 + text.length);
  new DataView(chunk.buffer).setUint32(0, text.length);
  chunk.set(new TextEncoder().encode("tEXt"), 4);
  chunk.set(text, 8);
  // CRC is verified for every chunk, so compute it with the codec's own algorithm.
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 8 + text.length)) {
    crc ^= byte;
    for (let k = 0; k < 8; k++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  new DataView(chunk.buffer).setUint32(
    8 + text.length,
    (crc ^ 0xffffffff) >>> 0,
  );
  const spliced = new Uint8Array(png.length + chunk.length);
  spliced.set(png.subarray(0, 33));
  spliced.set(chunk, 33);
  spliced.set(png.subarray(33), 33 + chunk.length);
  const prepared = prepareImage(spliced);
  assert.ok(!Buffer.from(prepared.bytes).includes("secret@example.com"));
});

test("rejects non-PNG, bad sizes, corruption and unsupported formats", () => {
  rejects(
    new TextEncoder().encode("GIF89a not a png at all, long enough....."),
    "unsupported_type",
  );
  rejects(new Uint8Array(10), "unsupported_type");
  rejects(encodePng(frog(63, 100)), "bad_dimensions");
  rejects(encodePng(frog(100, 1025)), "bad_dimensions");
  const good = encodePng(frog());
  // Flip one byte inside IDAT: checksum must fail.
  rejects(
    withBytes(good, (c) => {
      c[60] = (c[60] ?? 0) ^ 0xff;
    }),
    "invalid_image",
  );
  // Truncated stream.
  rejects(good.subarray(0, good.length - 20), "invalid_image");
  // Palette images are not accepted (colour type 3).
  rejects(
    withBytes(good, (c) => {
      c[25] = 3;
    }),
    "invalid_image",
  );
  // 16-bit depth is not accepted.
  rejects(
    withBytes(good, (c) => {
      c[24] = 16;
    }),
    "invalid_image",
  );
  // Interlaced is not accepted.
  rejects(
    withBytes(good, (c) => {
      c[28] = 1;
    }),
    "invalid_image",
  );
});

test("a decompression bomb larger than the header allows is refused", () => {
  const good = encodePng(frog(64, 64));
  // Same header, but the IDAT inflates to far more data than 64x64 needs.
  const bomb = deflateSync(Buffer.alloc(64 * 64 * 4 * 50));
  assert.ok(bomb.length < 100_000);
  const header = good.subarray(0, 33);
  const idat = new Uint8Array(12 + bomb.length);
  new DataView(idat.buffer).setUint32(0, bomb.length);
  idat.set(new TextEncoder().encode("IDAT"), 4);
  idat.set(bomb, 8);
  let crc = 0xffffffff;
  for (const byte of idat.subarray(4, 8 + bomb.length)) {
    crc ^= byte;
    for (let k = 0; k < 8; k++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  new DataView(idat.buffer).setUint32(
    8 + bomb.length,
    (crc ^ 0xffffffff) >>> 0,
  );
  const end = good.subarray(good.length - 12);
  const crafted = new Uint8Array(header.length + idat.length + end.length);
  crafted.set(header);
  crafted.set(idat, header.length);
  crafted.set(end, header.length + idat.length);
  rejects(crafted, "invalid_image");
});

test("uploads over 2 MiB are refused before decoding", () => {
  rejects(new Uint8Array(2 * 1024 * 1024 + 1), "too_large");
});
