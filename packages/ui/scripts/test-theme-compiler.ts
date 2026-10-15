import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RADA_THEME_TOKEN_NAMES } from "../src/index.ts";
import {
  compileTheme,
  contrastRatio,
  DEFAULT_THEME_BACKGROUND,
  semanticAccentFallback,
} from "../src/theme-compiler.ts";

const authoredPairs = [
  ["#000000", "#FFFFFF"],
  ["#FFFFFF", "#000000"],
  ["#FF0000", "#00FFFF"],
  ["#00FF00", "#FF00FF"],
  ["#0000FF", "#FFFF00"],
  ["#303CBB", "#C5AA5D"],
] as const;

for (const [background, accent] of authoredPairs) {
  const palette = compileTheme(background.toLowerCase(), accent.toLowerCase());
  assert.equal(
    palette.tokens["--theme-base"],
    background,
    "background drop must remain exact",
  );
  assert.equal(
    palette.tokens["--accent-solid"],
    accent,
    "accent drop must remain exact",
  );
  assert.equal(
    palette.tokens["--accent"],
    accent,
    "primary accent role must remain exact",
  );
  assert.equal(
    palette.tokens["--control-primary-bg"],
    accent,
    "primary controls must use the exact accent",
  );
  assert.ok(
    contrastRatio(
      palette.tokens["--surface-base"],
      palette.tokens["--text-primary"],
    ) >= 4.5,
    `${background}/${accent} surface text must meet WCAG AA`,
  );
  assert.ok(
    contrastRatio(accent, palette.tokens["--accent-ink"]) >= 4.5,
    `${background}/${accent} accent ink must meet WCAG AA`,
  );
  assert.ok(
    contrastRatio(
      palette.tokens["--surface-base"],
      palette.tokens["--accent-strong"],
    ) >= 4.5,
    `${background}/${accent} semantic accent emphasis must meet WCAG AA`,
  );
}

for (const background of [
  "#000000",
  "#FFFFFF",
  "#808080",
  "#FF0000",
  "#00FF00",
  "#0000FF",
]) {
  const fallback = semanticAccentFallback(background);
  assert.match(fallback, /^#[0-9A-F]{6}$/);
  assert.ok(
    fallback === "#F4F4F0" || fallback === "#202220",
    "locked controls must use one adaptive neutral pair",
  );
  const palette = compileTheme(background);
  assert.equal(palette.tokens["--accent-solid"], fallback);
  assert.ok(
    contrastRatio(fallback, palette.tokens["--accent-ink"]) >= 4.5,
    "locked controls must remain readable",
  );
}

function packedHex(value: number): string {
  return `#${(value & 0xff_ffff).toString(16).padStart(6, "0").toUpperCase()}`;
}

// Deterministic property sample across arbitrary pairs. These are rendering
// checks only: the compiler must preserve each exact drop while choosing
// readable semantic ink for colours the old curated palettes never contained.
let sampleState = 0x6d2b_79f5;
const sampledPairs = 4_096;
for (let index = 0; index < sampledPairs; index += 1) {
  sampleState = (Math.imul(sampleState, 1_664_525) + 1_013_904_223) >>> 0;
  const background = packedHex(sampleState);
  sampleState = (Math.imul(sampleState, 1_664_525) + 1_013_904_223) >>> 0;
  const accent = packedHex(sampleState);
  const palette = compileTheme(background, accent);
  assert.equal(palette.tokens["--theme-base"], background);
  assert.equal(palette.tokens["--accent-solid"], accent);
  assert.ok(
    contrastRatio(
      palette.tokens["--surface-base"],
      palette.tokens["--text-primary"],
    ) >= 4.5,
  );
  assert.ok(contrastRatio(accent, palette.tokens["--accent-ink"]) >= 4.5);
  assert.ok(
    contrastRatio(
      palette.tokens["--surface-base"],
      palette.tokens["--accent-strong"],
    ) >= 4.5,
  );
}

assert.equal(
  compileTheme("invalid", "also-invalid").tokens["--theme-base"],
  DEFAULT_THEME_BACKGROUND,
);

// This stylesheet is the static first-paint palette and token transport
// contract for embedded apps. Keep both mechanically identical to
// the compiler so an iframe or slow hydration cannot flash a retired palette.
const defaultPalette = compileTheme(DEFAULT_THEME_BACKGROUND);
assert.deepEqual(
  [...RADA_THEME_TOKEN_NAMES].sort(),
  Object.keys(defaultPalette.tokens).sort(),
  "UI token contract must carry every compiler role and no private legacy roles",
);
const sharedCss = await readFile(
  new URL("../src/design-system.css", import.meta.url),
  "utf8",
);
function normalizeCssValue(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/(?<![\w])0\.(\d+)/g, ".$1")
    .replace(/(\.\d*?[1-9])0+(?=[);,])/g, "$1");
}
for (const [name, value] of Object.entries(defaultPalette.tokens)) {
  const declaration = sharedCss.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(declaration, `UI first-paint CSS must declare ${name}`);
  assert.equal(
    normalizeCssValue(declaration[1] ?? ""),
    normalizeCssValue(value),
    `${name} first-paint value must match the compiler`,
  );
}
process.stdout.write(
  `theme compiler: ${String(authoredPairs.length)} anchors + ${String(sampledPairs)} arbitrary pairs preserve exact HEX; UI carries ${String(RADA_THEME_TOKEN_NAMES.length)} matching roles\n`,
);
