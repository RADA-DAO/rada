/**
 * The application has at most two authored JPEGPE colours: background and,
 * once Level 2 is open, accent. This compiler preserves those exact HEX values
 * and derives only semantic UI roles (surfaces, readable ink, borders and
 * interaction states). A locked accent receives a neutral control fallback,
 * never a synthetic collectible colour. It never classifies, scores, rerolls
 * or "improves" a collectible colour.
 */

type RGB = { r: number; g: number; b: number };
const rgbChannels = ({ r, g, b }: RGB): string => [r, g, b].join(" ");
type OKLCH = { l: number; c: number; h: number };

export const DEFAULT_THEME_BACKGROUND = "#243B34";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizedHexColor(
  value: string | null | undefined,
  fallback = DEFAULT_THEME_BACKGROUND,
): string {
  return value && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : fallback.toUpperCase();
}

function hexToRgb(hex: string): RGB {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function srgbToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  const value =
    channel <= 0.0031308
      ? channel * 12.92
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  return clamp(value, 0, 1) * 255;
}

function rgbToOklch({ r, g, b }: RGB): OKLCH {
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
    chroma < 0.000004
      ? 0
      : ((Math.atan2(axisB, axisA) * 180) / Math.PI + 360) % 360;
  return { l: lightness, c: chroma, h: hue };
}

function oklchToLinearRgb({ l, c, h }: OKLCH): RGB {
  const radians = (h * Math.PI) / 180;
  const axisA = c * Math.cos(radians);
  const axisB = c * Math.sin(radians);
  const lRoot = l + 0.3963377774 * axisA + 0.2158037573 * axisB;
  const mRoot = l - 0.1055613458 * axisA - 0.0638541728 * axisB;
  const sRoot = l - 0.0894841775 * axisA - 1.291485548 * axisB;
  const lCube = lRoot ** 3;
  const mCube = mRoot ** 3;
  const sCube = sRoot ** 3;
  return {
    r: 4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube,
    g: -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube,
    b: -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube,
  };
}

function isLinearRgbInGamut(rgb: RGB): boolean {
  return (
    rgb.r >= 0 &&
    rgb.r <= 1 &&
    rgb.g >= 0 &&
    rgb.g <= 1 &&
    rgb.b >= 0 &&
    rgb.b <= 1
  );
}

function maxOklchChroma(lightness: number, hue: number): number {
  let low = 0;
  let high = 0.42;
  for (let step = 0; step < 16; step += 1) {
    const middle = (low + high) / 2;
    if (
      isLinearRgbInGamut(oklchToLinearRgb({ l: lightness, c: middle, h: hue }))
    )
      low = middle;
    else high = middle;
  }
  return low;
}

function oklchToHex(color: OKLCH): string {
  const lightness = clamp(color.l, 0, 1);
  const chroma = Math.min(
    Math.max(0, color.c),
    maxOklchChroma(lightness, color.h),
  );
  const rgb = oklchToLinearRgb({ l: lightness, c: chroma, h: color.h });
  return `#${[rgb.r, rgb.g, rgb.b]
    .map((channel) =>
      Math.round(linearToSrgb(channel)).toString(16).padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

function colorWithAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  return `rgb(${rgbChannels(rgb)} / ${clamp(alpha, 0, 1).toFixed(3)})`;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(normalizedHexColor(hex));
  const [red, green, blue] = [r, g, b].map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function readableInk(background: string): "#000000" | "#FFFFFF" {
  // Across the entire 24-bit sRGB cube, choosing the higher-contrast member of
  // pure black/white guarantees at least 4.58:1 without altering the authored
  // background or accent itself.
  return contrastRatio(background, "#000000") >=
    contrastRatio(background, "#FFFFFF")
    ? "#000000"
    : "#FFFFFF";
}

/**
 * Level 1 has no collectible accent yet. This value exists only so UI controls
 * remain readable; it is never persisted or presented as a dropped trait.
 */
export function semanticAccentFallback(
  backgroundColor: string | null | undefined,
): string {
  const background = rgbToOklch(hexToRgb(normalizedHexColor(backgroundColor)));
  // Locked means absent, not a white or background-tinted collectible colour.
  // Use one neutral control pair with an adaptive pole so it remains legible
  // across the complete background cube without impersonating an accent drop.
  return background.l < 0.625 ? "#F4F4F0" : "#202220";
}

export function compileTheme(
  backgroundColor: string,
  accentColor?: string | null,
) {
  const authoredBackground = normalizedHexColor(backgroundColor);
  const authoredAccent =
    accentColor && /^#[0-9a-f]{6}$/i.test(accentColor)
      ? accentColor.toUpperCase()
      : semanticAccentFallback(authoredBackground);
  const authored = rgbToOklch(hexToRgb(authoredBackground));
  const neutral = authored.c < 0.025;
  const themeHue = neutral ? 245 : authored.h;
  const sourceTone: "light" | "dark" = authored.l >= 0.625 ? "light" : "dark";
  const environmentL =
    sourceTone === "light"
      ? clamp(authored.l, 0.68, 0.82)
      : clamp(authored.l, 0.25, 0.56);
  const environmentC = neutral
    ? Math.min(authored.c, 0.018)
    : Math.min(authored.c, maxOklchChroma(environmentL, themeHue) * 0.94);
  const environment: OKLCH = { l: environmentL, c: environmentC, h: themeHue };
  const environmentTop: OKLCH = {
    l: clamp(
      environmentL + (sourceTone === "light" ? 0.035 : 0.055),
      0.18,
      0.9,
    ),
    c: environmentC * 0.88,
    h: themeHue,
  };
  const environmentBottom: OKLCH = {
    l: clamp(
      environmentL - (sourceTone === "light" ? 0.055 : 0.04),
      0.16,
      0.84,
    ),
    c: environmentC * 1.02,
    h: themeHue,
  };
  const waterMid = oklchToHex(environment);
  const waterTop = oklchToHex(environmentTop);
  const waterBottom = oklchToHex(environmentBottom);

  const surfaceL =
    sourceTone === "dark"
      ? clamp(environmentL + 0.075, 0.32, 0.68)
      : clamp(environmentL + 0.105, 0.79, 0.94);
  const surfaceC = environmentC * (sourceTone === "dark" ? 0.72 : 0.42);
  const surface: OKLCH = { l: surfaceL, c: surfaceC, h: themeHue };
  const raised: OKLCH = {
    l: clamp(surfaceL + (sourceTone === "dark" ? 0.04 : 0.025), 0.36, 0.965),
    c: surfaceC * 0.84,
    h: themeHue,
  };
  const soft: OKLCH = {
    l: clamp(
      environmentL + (sourceTone === "dark" ? 0.045 : 0.065),
      0.29,
      0.91,
    ),
    c: environmentC * (sourceTone === "dark" ? 0.58 : 0.34),
    h: themeHue,
  };
  const surfacePigment = oklchToHex(surface);
  const surfaceHighlight = oklchToHex(raised);
  const surfaceSoft = oklchToHex(soft);
  const surfaceShadow = oklchToHex({
    l: clamp(environmentL - (sourceTone === "dark" ? 0.075 : 0.12), 0.08, 0.78),
    c: environmentC * 0.78,
    h: themeHue,
  });

  const darkInk = oklchToHex({
    l: 0.16,
    c: neutral ? 0.006 : 0.018,
    h: themeHue,
  });
  const lightInk = oklchToHex({
    l: 0.985,
    c: neutral ? 0.002 : 0.008,
    h: themeHue,
  });
  const tone: "light" | "dark" =
    contrastRatio(surfacePigment, lightInk) >
    contrastRatio(surfacePigment, darkInk)
      ? "dark"
      : "light";
  let ink = tone === "dark" ? lightInk : darkInk;
  if (contrastRatio(surfacePigment, ink) < 4.5)
    ink = readableInk(surfacePigment);
  const inkRgb = hexToRgb(ink);
  const muted = `rgb(${rgbChannels(inkRgb)} / ${tone === "dark" ? ".68" : ".62"})`;

  const accentOklch = rgbToOklch(hexToRgb(authoredAccent));
  const accentRgb = hexToRgb(authoredAccent);
  const accentHighlight = oklchToHex({
    l: clamp(accentOklch.l + 0.16, 0.64, 0.9),
    c: accentOklch.c * 0.72,
    h: accentOklch.h,
  });
  const accentShade = oklchToHex({
    l: clamp(accentOklch.l - 0.18, 0.22, 0.58),
    c: accentOklch.c * 0.78,
    h: accentOklch.h,
  });
  const accentInk = readableInk(authoredAccent);
  let accentStrong = oklchToHex({
    l: tone === "dark" ? 0.94 : 0.13,
    c: Math.min(accentOklch.c * 0.42, 0.055),
    h: accentOklch.h,
  });
  if (contrastRatio(surfacePigment, accentStrong) < 4.5)
    accentStrong = readableInk(surfacePigment);
  // Functional indicators need contrast; never change the collectible accent token.
  let accentIndicator = authoredAccent;
  for (let step = 0; step <= 100; step++) {
    if (
      Math.min(
        contrastRatio(accentIndicator, surfacePigment),
        contrastRatio(accentIndicator, surfaceHighlight),
      ) >= 3
    )
      break;
    const t = (step + 1) / 101;
    accentIndicator = oklchToHex({
      l: accentOklch.l + ((tone === "dark" ? 1 : 0) - accentOklch.l) * t,
      c: accentOklch.c * (1 - t),
      h: accentOklch.h,
    });
  }
  const accentSoft = colorWithAlpha(
    authoredAccent,
    tone === "dark" ? 0.24 : 0.16,
  );
  const accentBorder = colorWithAlpha(
    authoredAccent,
    tone === "dark" ? 0.76 : 0.62,
  );
  const shadow = hexToRgb(surfaceShadow);
  const edgeBottom = colorWithAlpha(
    surfaceShadow,
    tone === "dark" ? 0.46 : 0.3,
  );

  return {
    chrome: waterTop,
    tone,
    tokens: {
      // theme-base is always exact; accent-solid is exact once the accent is
      // unlocked and is otherwise the neutral control fallback described above.
      "--theme-base": authoredBackground,
      "--accent-solid": authoredAccent,
      "--theme-ring": authoredAccent,
      "--water-top": waterTop,
      "--water-mid": waterMid,
      "--water-bottom": waterBottom,
      "--environment-top": waterTop,
      "--environment-mid": waterMid,
      "--environment-bottom": waterBottom,
      "--accent": authoredAccent,
      "--accent-2": accentHighlight,
      "--accent-3": accentShade,
      "--accent-sun": authoredAccent,
      "--accent-rgb": rgbChannels(accentRgb),
      "--ink": ink,
      "--ink-rgb": rgbChannels(inkRgb),
      "--muted": muted,
      "--text-primary": ink,
      "--text-muted": muted,
      "--shadow-rgb": rgbChannels(shadow),
      "--surface-pigment": surfacePigment,
      "--surface-highlight": surfaceHighlight,
      "--surface-shadow": surfaceShadow,
      "--surface-base": surfacePigment,
      "--surface-raised": surfaceHighlight,
      "--surface-soft": surfaceSoft,
      "--glass-fill": surfacePigment,
      "--glass-fill-strong": surfaceHighlight,
      "--glass-fill-soft": surfaceSoft,
      "--glass-edge":
        tone === "dark" ? "rgb(255 255 255 / .2)" : "rgb(255 255 255 / .82)",
      "--glass-edge-bottom": edgeBottom,
      "--glass-glint":
        tone === "dark" ? "rgb(255 255 255 / .12)" : "rgb(255 255 255 / .55)",
      "--accent-soft": accentSoft,
      "--accent-strong": accentStrong,
      "--accent-indicator": accentIndicator,
      "--accent-ink": accentInk,
      "--accent-ring": authoredAccent,
      "--control-primary-bg": authoredAccent,
      "--control-primary-ink": accentInk,
      "--control-primary-border": accentBorder,
      "--control-secondary-bg": surfaceHighlight,
      "--control-secondary-ink": ink,
      "--control-secondary-border":
        tone === "dark" ? "rgb(255 255 255 / .2)" : "rgb(255 255 255 / .82)",
      "--control-selected-bg": accentSoft,
      "--control-selected-ink": ink,
      "--control-disabled-bg": surfaceSoft,
      "--control-disabled-ink": muted,
    },
  };
}

export type ThemePalette = ReturnType<typeof compileTheme>;
