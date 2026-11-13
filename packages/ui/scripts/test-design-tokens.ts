import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { RADA_DESIGN_TOKEN_NAMES, type DesignTokenName } from "../src/index.ts";

const source = new URL("../src/", import.meta.url);
const normalize = (value: string): string =>
  value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/(?<![\w])0\.(\d+)/g, ".$1");
const tokensCss = await readFile(new URL("tokens.css", source), "utf8");
const declarations = new Map(
  [...tokensCss.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
    match[1],
    normalize(match[2] ?? ""),
  ]),
);

await test("UI CSS never embeds fonts and bundled WOFF2 stays below 250 KB", async () => {
  const root = new URL("../", import.meta.url);
  const paths = await readdir(root, { recursive: true });
  for (const path of paths.filter((path) => path.endsWith(".css"))) {
    const css = await readFile(new URL(path, root), "utf8");
    assert.doesNotMatch(css, /data:\s*font|data:[^)]*;base64/i, path);
  }
  const fonts = await Promise.all(
    paths
      .filter((path) => path.endsWith(".woff2"))
      .map((path) => readFile(new URL(path, root))),
  );
  assert.ok(fonts.length > 0, "bundled WOFF2 fonts must exist");
  const bytes = fonts.reduce((total, font) => total + font.byteLength, 0);
  assert.ok(bytes < 250_000, `font budget exceeded: ${String(bytes)} bytes`);
});

await test("CSS foundations match the complete typed token contract", () => {
  assert.deepEqual(
    [...declarations.keys()].sort(),
    [...RADA_DESIGN_TOKEN_NAMES].sort(),
  );
});

await test("canonical foundations preserve the profile vocabulary", () => {
  const expected: Partial<Record<DesignTokenName, string>> = {
    "--rada-reading-width": "740px",
    "--rada-space": "8px",
    "--rada-radius-panel": "28px 16px 28px 16px",
    "--rada-radius-control": "16px 11px 16px 11px",
    "--rada-radius-small": "12px 8px 12px 8px",
    "--rada-control-height": "46px",
    "--rada-field-height": "48px",
    "--rada-font-size-body": "1.0625rem",
    "--rada-font-size-field": "1.0625rem",
    "--rada-font-size-section": "1.375rem",
    "--rada-font-size-title": "clamp(1.6875rem, 7vw, 2.1875rem)",
    "--rada-font-weight-body": "400",
    "--rada-font-weight-control": "500",
    "--rada-font-weight-heading": "600",
    "--rada-shell-width": "900px",
    "--rada-ease-emphasized": "cubic-bezier(.2, .8, .2, 1)",
  };
  for (const [name, value] of Object.entries(expected))
    assert.equal(declarations.get(name), normalize(value));
  assert.match(
    declarations.get("--rada-font-body") ?? "",
    /^-apple-system, BlinkMacSystemFont,/,
  );
  assert.match(
    declarations.get("--rada-font-heading") ?? "",
    /^var\(--rada-font-body\)/,
  );
});

await test("one public entry supplies all recipes with resolvable token references", async () => {
  const entry = await readFile(new URL("design-system.css", source), "utf8");
  const imports = [...entry.matchAll(/@import "\.\/([\w-]+\.css)";/g)].map(
    (match) => match[1] ?? "",
  );
  assert.deepEqual(imports, [
    "tokens.css",
    "primitives.css",
    "components.css",
    "launcher.css",
    "frog-card.css",
    "shell.css",
  ]);
  const recipes = await Promise.all(
    imports.map((name) => readFile(new URL(name, source), "utf8")),
  );
  const allCss = [entry, ...recipes].join("\n");
  const names = new Set(
    [...allCss.matchAll(/(--[\w-]+):/g)].map((match) => match[1]),
  );
  for (const match of allCss.matchAll(/var\((--rada-[\w-]+)/g))
    assert.ok(names.has(match[1]), `missing ${String(match[1])}`);
  // Per-card authored colors must resolve in the card's scope, not at :root.
  assert.doesNotMatch(tokensCss.split(".jpegpe-card")[0] ?? "", /--frog-card-/);
  assert.match(tokensCss, /\.jpegpe-card\s*\{[\s\S]*--rada-frog-plane-fill:/);
  assert.match(recipes[1] ?? "", /prefers-reduced-motion: reduce/);
  assert.match(recipes[1] ?? "", /var\(--rada-duration-reduced\)/);
  assert.match(recipes[2] ?? "", /prefers-reduced-motion: reduce/);
  for (const css of recipes.slice(1))
    assert.doesNotMatch(
      css,
      /\b\d*\.?\d+(?:px|rem|cqw|ms)\b/,
      "recipe dimensions belong to tokens",
    );
});

await test("the current matte canvas is static and the child foundation has no external assets", async () => {
  const community = await readFile(new URL("community.css", source), "utf8");
  assert.doesNotMatch(community, /@import|url\s*\(|https?:|#[0-9a-f]{3,8}\b/i);
  assert.match(community, /background: transparent/);
  assert.match(community, /var\(--rada-font-size-body\)/);
  assert.equal(declarations.get("--rada-environment-highlight-opacity"), ".3");
  assert.match(
    declarations.get("--rada-environment-highlight") ?? "",
    /ellipse at 50% -8%/,
  );
});

await test("systemic copy scales with root text size while collectible tokens stay separate", () => {
  for (const name of ["--rada-font-size-body", "--rada-font-size-field"]) {
    const value = declarations.get(name) ?? "";
    assert.match(value, /^1\.0625rem$/);
    const factor = Number.parseFloat(value);
    assert.equal(
      factor * 16,
      17,
      "normal root retains the production 17px size",
    );
    assert.equal(factor * 20, 21.25, "125% root grows copy once");
  }
  assert.equal(declarations.get("--rada-font-size-section"), "1.375rem");
  assert.match(
    declarations.get("--rada-font-size-title") ?? "",
    /^clamp\(1\.6875rem, 7vw, 2\.1875rem\)$/,
  );
  const card = tokensCss.split("/* Resolve collectible-local colors")[1];
  assert.ok(card, "collectible-local geometry remains its own token scope");
  assert.match(card, /--rada-frog-name-font:/);
});
