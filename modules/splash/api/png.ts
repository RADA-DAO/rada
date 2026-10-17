import { Buffer } from "node:buffer";
import { deflateSync, inflateSync } from "node:zlib";

export type Raster = { width: number; height: number; rgba: Uint8Array };

// Hard pixel allocation ceiling, independent of caller validation (256 MiB RGBA).
export const MAX_DECODED_BYTES = 8192 * 8192 * 4;

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class InvalidPng extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Reads only the header: signature, then IHDR width and height. */
export function pngDimensions(bytes: Uint8Array) {
  if (bytes.length < 33 || SIGNATURE.some((value, i) => bytes[i] !== value))
    throw new InvalidPng("signature");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452)
    throw new InvalidPng("header");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decodes 8-bit RGB or RGBA, non-interlaced PNG. Every chunk checksum is verified
 * and the decompressed size must match the header exactly, so a crafted stream
 * cannot expand beyond width x height. Callers bound the dimensions first.
 */
export function decodePng(bytes: Uint8Array): Raster {
  const { width, height } = pngDimensions(bytes);
  if (!width || !height || width * height * 4 > MAX_DECODED_BYTES)
    throw new InvalidPng("memory_bound");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const depth = bytes[24];
  const colorType = bytes[25];
  if (
    depth !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    bytes[26] !== 0 ||
    bytes[27] !== 0 ||
    bytes[28] !== 0
  )
    throw new InvalidPng("unsupported_format");
  const channels = colorType === 6 ? 4 : 3;
  const data: Uint8Array[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= bytes.length && !ended) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new InvalidPng("truncated");
    const body = bytes.subarray(offset + 4, offset + 8 + length);
    if (view.getUint32(offset + 8 + length) !== crc32(body))
      throw new InvalidPng("checksum");
    const type = String.fromCharCode(...body.subarray(0, 4));
    if (type === "IDAT") data.push(body.subarray(4));
    else if (type === "IEND") ended = true;
    else if (type === "IHDR" && offset !== 8) throw new InvalidPng("header");
    else if (type === "PLTE" || type === "acTL")
      throw new InvalidPng("unsupported_format");
    offset = end;
  }
  if (!ended || !data.length) throw new InvalidPng("truncated");
  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  } catch {
    throw new InvalidPng("data");
  }
  if (raw.length !== expected) throw new InvalidPng("data");
  const rgba = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const filter = raw[start];
    for (let x = 0; x < stride; x++) {
      const value = raw[start + 1 + x] ?? 0;
      const left = x >= channels ? (line[x - channels] ?? 0) : 0;
      const up = previous[x] ?? 0;
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
      let predictor: number;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else throw new InvalidPng("data");
      line[x] = (value + predictor) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4;
      rgba[target] = line[x * channels] ?? 0;
      rgba[target + 1] = line[x * channels + 1] ?? 0;
      rgba[target + 2] = line[x * channels + 2] ?? 0;
      rgba[target + 3] = channels === 4 ? (line[x * channels + 3] ?? 0) : 255;
    }
    previous = Uint8Array.from(line);
  }
  return { width, height, rgba };
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** Encodes RGBA with filter 0 on every row. */
export function encodePng({ width, height, rgba }: Raster): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const parts = [
    Uint8Array.from(SIGNATURE),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
