/**
 * JPEGPE public colour drop protocol v1.
 *
 * This module is intentionally dependency-free and usable from Node, Deno and
 * browser-compatible runtimes. It contains no Supabase or Telegram code.
 */

export const COLOR_DROP_PROTOCOL_VERSION = 1 as const;
export const COLOR_DERIVATION_VERSION = "JPEGPE_COLOR_V1" as const;
export const DRAND_QUICKNET_CHAIN_HASH =
  "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971" as const;

export const COLOR_PURPOSES = ["background", "accent"] as const;
export type ColorPurpose = (typeof COLOR_PURPOSES)[number];

/** Domain-separates the two independent authored-colour drops. */
export const COLOR_PURPOSE_CODES: Readonly<Record<ColorPurpose, number>> = {
  background: 0x01,
  accent: 0x02,
};

export const COLOR_CLASS_IDS = [
  "CHROMATIC_RED",
  "CHROMATIC_YELLOW",
  "CHROMATIC_GREEN",
  "CHROMATIC_CYAN",
  "CHROMATIC_BLUE",
  "CHROMATIC_MAGENTA",
  "NEUTRAL_DARK",
  "NEUTRAL_GRAY",
  "NEUTRAL_LIGHT",
] as const;

export type ColorClass = (typeof COLOR_CLASS_IDS)[number];

/**
 * Canonical product-facing faction taxonomy.
 *
 * Color Drop Protocol v1 proofs keep their frozen nine-class `ColorClass`
 * value. Product surfaces collapse its three neutral lightness bands into the
 * one neutral faction represented by the single grey lily/lilypad asset.
 */
export const COLOR_FACTION_IDS = [
  "CHROMATIC_RED",
  "CHROMATIC_YELLOW",
  "CHROMATIC_GREEN",
  "CHROMATIC_CYAN",
  "CHROMATIC_BLUE",
  "CHROMATIC_MAGENTA",
  "NEUTRAL",
] as const;

export const COLOR_FACTION_TAXONOMY_VERSION = 1 as const;
export type ColorFaction = (typeof COLOR_FACTION_IDS)[number];
export type RGB = { r: number; g: number; b: number };
export type OKLCH = { l: number; c: number; h: number };

export const NEUTRAL_CHROMA_LIMIT = 0.02;
export const DARK_LIGHTNESS_LIMIT = 0.25;
export const LIGHT_LIGHTNESS_LIMIT = 0.95;

/** Hue boundaries are evaluated as half-open intervals in degrees. */
export const CHROMATIC_HUE_BOUNDARIES = {
  // The six-decimal audit cut points are nudged by less than 0.000002° from
  // the exploratory values so the executable JS reference owns the exact
  // full-space populations across boundary-adjacent HEX values.
  redEnd: 55.710054,
  yellowEnd: 130.579391,
  greenEnd: 154.411301,
  cyanEnd: 246.615921,
  blueEnd: 299.538239,
  magentaEnd: 350.057318,
} as const;

export const EXPECTED_FULL_SPACE_POPULATIONS: Readonly<
  Record<ColorClass, number>
> = {
  CHROMATIC_RED: 2_768_700,
  CHROMATIC_YELLOW: 2_768_699,
  CHROMATIC_GREEN: 2_768_699,
  CHROMATIC_CYAN: 2_768_700,
  CHROMATIC_BLUE: 2_768_699,
  CHROMATIC_MAGENTA: 2_768_699,
  NEUTRAL_DARK: 11_022,
  NEUTRAL_GRAY: 144_041,
  NEUTRAL_LIGHT: 9_957,
};

export const EXPECTED_FACTION_POPULATIONS: Readonly<
  Record<ColorFaction, number>
> = {
  CHROMATIC_RED: EXPECTED_FULL_SPACE_POPULATIONS.CHROMATIC_RED,
  CHROMATIC_YELLOW: EXPECTED_FULL_SPACE_POPULATIONS.CHROMATIC_YELLOW,
  CHROMATIC_GREEN: EXPECTED_FULL_SPACE_POPULATIONS.CHROMATIC_GREEN,
  CHROMATIC_CYAN: EXPECTED_FULL_SPACE_POPULATIONS.CHROMATIC_CYAN,
  CHROMATIC_BLUE: EXPECTED_FULL_SPACE_POPULATIONS.CHROMATIC_BLUE,
  CHROMATIC_MAGENTA: EXPECTED_FULL_SPACE_POPULATIONS.CHROMATIC_MAGENTA,
  NEUTRAL:
    EXPECTED_FULL_SPACE_POPULATIONS.NEUTRAL_DARK +
    EXPECTED_FULL_SPACE_POPULATIONS.NEUTRAL_GRAY +
    EXPECTED_FULL_SPACE_POPULATIONS.NEUTRAL_LIGHT,
};

/** SHA-256 of one class-code byte per packed RGB value, RRGGBB ascending. */
export const EXPECTED_CLASSIFICATION_MAP_SHA256 =
  "6e8a82181c0e126a8d32aa057f299df79d936790f596779df4e790dcc1fe3715" as const;

const HUE_POWERLESS_EPSILON = 0.000004;

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error(`${name} must be an integer between 0 and 255`);
  }
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function hexToRgb(hex: string): RGB {
  if (!/^#[0-9a-f]{6}$/i.test(hex))
    throw new Error(`invalid HEX colour: ${hex}`);
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  assertByte(r, "r");
  assertByte(g, "g");
  assertByte(b, "b");
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function rgbToOklch({ r, g, b }: RGB): OKLCH {
  const red = srgbToLinear(r);
  const green = srgbToLinear(g);
  const blue = srgbToLinear(b);
  const l = Math.cbrt(
    0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue,
  );
  const m = Math.cbrt(
    0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue,
  );
  const s = Math.cbrt(
    0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue,
  );
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const axisA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const axisB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(axisA, axisB);
  const hue =
    chroma < HUE_POWERLESS_EPSILON
      ? 0
      : ((Math.atan2(axisB, axisA) * 180) / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

export function hexToOklch(hex: string): OKLCH {
  return rgbToOklch(hexToRgb(hex));
}

export function classifyOklch(color: OKLCH): ColorClass {
  if (color.c < NEUTRAL_CHROMA_LIMIT) {
    if (color.l < DARK_LIGHTNESS_LIMIT) return "NEUTRAL_DARK";
    if (color.l > LIGHT_LIGHTNESS_LIMIT) return "NEUTRAL_LIGHT";
    return "NEUTRAL_GRAY";
  }

  const { redEnd, yellowEnd, greenEnd, cyanEnd, blueEnd, magentaEnd } =
    CHROMATIC_HUE_BOUNDARIES;
  if (color.h < redEnd || color.h >= magentaEnd) return "CHROMATIC_RED";
  if (color.h < yellowEnd) return "CHROMATIC_YELLOW";
  if (color.h < greenEnd) return "CHROMATIC_GREEN";
  if (color.h < cyanEnd) return "CHROMATIC_CYAN";
  if (color.h < blueEnd) return "CHROMATIC_BLUE";
  return "CHROMATIC_MAGENTA";
}

export function classifyRgb(rgb: RGB): ColorClass {
  return classifyOklch(rgbToOklch(rgb));
}

export function classifyHex(hex: string): ColorClass {
  return classifyRgb(hexToRgb(hex));
}

export function colorClassToFaction(colorClass: ColorClass): ColorFaction {
  switch (colorClass) {
    case "NEUTRAL_DARK":
    case "NEUTRAL_GRAY":
    case "NEUTRAL_LIGHT":
      return "NEUTRAL";
    default:
      return colorClass;
  }
}

export function classifyOklchFaction(color: OKLCH): ColorFaction {
  return colorClassToFaction(classifyOklch(color));
}

export function classifyRgbFaction(rgb: RGB): ColorFaction {
  return colorClassToFaction(classifyRgb(rgb));
}

export function classifyHexFaction(hex: string): ColorFaction {
  return colorClassToFaction(classifyHex(hex));
}

export function colorClassCode(colorClass: ColorClass): number {
  const code = COLOR_CLASS_IDS.indexOf(colorClass);
  if (code < 0) throw new Error(`unknown colour class: ${colorClass}`);
  return code;
}

function hexBytes(
  value: string,
  expectedBytes: number,
  name: string,
): Uint8Array {
  const normalized = value.toLowerCase();
  if (
    !new RegExp(`^[0-9a-f]{${String(expectedBytes * 2)}}$`).test(normalized)
  ) {
    throw new Error(
      `${name} must contain exactly ${String(expectedBytes)} bytes as lowercase/uppercase HEX`,
    );
  }
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1) {
    bytes[index] = Number.parseInt(
      normalized.slice(index * 2, index * 2 + 2),
      16,
    );
  }
  return bytes;
}

function uuidBytes(uuid: string, name: string): Uint8Array {
  const normalized = uuid.toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalized,
    )
  ) {
    throw new Error(`${name} must be an RFC 4122/9562 UUID`);
  }
  return hexBytes(normalized.replaceAll("-", ""), 16, name);
}

function roundBytes(round: bigint | number | string): Uint8Array {
  let value: bigint;
  if (typeof round === "bigint") {
    value = round;
  } else if (typeof round === "number") {
    if (!Number.isSafeInteger(round))
      throw new Error("round number must be a safe integer");
    value = BigInt(round);
  } else {
    if (!/^\d+$/.test(round))
      throw new Error("round string must contain decimal digits only");
    value = BigInt(round);
  }
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new Error("round must fit uint64");
  const bytes = new Uint8Array(8);
  let remainder = value;
  for (let index = 7; index >= 0; index -= 1) {
    bytes[index] = Number(remainder & 0xffn);
    remainder >>= 8n;
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export type ColorDerivationInput = {
  purpose: ColorPurpose;
  chainHash?: string;
  round: bigint | number | string;
  randomness: string;
  frogId: string;
  requestId: string;
};

export function buildColorDerivationInput({
  purpose,
  chainHash = DRAND_QUICKNET_CHAIN_HASH,
  round,
  randomness,
  frogId,
  requestId,
}: ColorDerivationInput): Uint8Array {
  if (!COLOR_PURPOSES.includes(purpose)) {
    throw new Error(`purpose must be one of: ${COLOR_PURPOSES.join(", ")}`);
  }
  if (chainHash.toLowerCase() !== DRAND_QUICKNET_CHAIN_HASH) {
    throw new Error(
      "chainHash must equal the pinned drand Quicknet v1 chain hash",
    );
  }
  const domain = new TextEncoder().encode(COLOR_DERIVATION_VERSION);
  return concatBytes(
    domain,
    new Uint8Array([0]),
    new Uint8Array([COLOR_PURPOSE_CODES[purpose]]),
    hexBytes(chainHash, 32, "chainHash"),
    roundBytes(round),
    hexBytes(randomness, 32, "randomness"),
    uuidBytes(frogId, "frogId"),
    uuidBytes(requestId, "requestId"),
  );
}

function digestToHex(digest: Uint8Array): string {
  return `#${Array.from(digest.slice(0, 3), (byte) => byte.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export async function deriveColorHex(
  input: ColorDerivationInput,
): Promise<string> {
  const bytes = buildColorDerivationInput(input);
  const source = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", source);
  return digestToHex(new Uint8Array(digest));
}

export async function deriveColorRecord(input: ColorDerivationInput): Promise<{
  purpose: ColorPurpose;
  colorHex: string;
  colorClass: ColorClass;
  algorithmVersion: typeof COLOR_DERIVATION_VERSION;
}> {
  const colorHex = await deriveColorHex(input);
  return {
    purpose: input.purpose,
    colorHex,
    colorClass: classifyHex(colorHex),
    algorithmVersion: COLOR_DERIVATION_VERSION,
  };
}
