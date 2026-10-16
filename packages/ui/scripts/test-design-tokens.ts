import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    "--rada-ease-emphasized": "cubic-bezier(.2, .8, .2, 1)",
  };
  for (const [name, value] of Object.entries(expected))
    assert.equal(declarations.get(name), normalize(value));
  assert.match(declarations.get("--rada-font-body") ?? "", /^Onest,/);
  assert.match(
    declarations.get("--rada-font-heading") ?? "",
    /^Outfit, Onest,/,
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
