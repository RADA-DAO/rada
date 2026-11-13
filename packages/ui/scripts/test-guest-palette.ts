import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compileTheme, DEFAULT_THEME_BACKGROUND } from "../src/index.ts";

const css = await readFile(
  new URL("../src/design-system.css", import.meta.url),
  "utf8",
);
const rootBlock = /(?:^|\n):root\s*\{([^}]*)\}/.exec(css)?.[1];
const normalize = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/(?<![\w])0\.(\d+)/g, ".$1")
    .replace(/(\.\d*?[1-9])0+(?=[)\s;,]|$)/g, "$1")
    .replace(/\.0+(?=[)\s;,]|$)/g, "");

await test("guest first-paint palette equals compileTheme for the guest theme", () => {
  assert.ok(rootBlock, "design-system.css declares a :root block");
  const declared = new Map(
    [...rootBlock.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1] ?? "",
      normalize(match[2] ?? ""),
    ]),
  );
  const compiled = new Map(
    Object.entries(compileTheme(DEFAULT_THEME_BACKGROUND).tokens).map(
      ([name, value]) => [name, normalize(value)],
    ),
  );
  assert.deepEqual(
    [...declared.keys()].sort(),
    [...compiled.keys()].sort(),
    "the :root block carries exactly the compiler roles",
  );
  for (const [name, value] of compiled)
    assert.equal(
      declared.get(name),
      value,
      `${name} drifted from the compiler`,
    );
});

await test("production palette fixtures retain pigment with bounded readable material stops", () => {
  // Pinned production compiler 064c32e; gray water receives the minimal AA guard.
  const fixtures = {
    "#164E42": [
      "#2F5C51",
      "#164E42",
      "#044338",
      "#3C6057",
      "#4D6A62",
      "#3A564F",
    ],
    "#808080": [
      "#848484",
      "#828282",
      "#828282",
      "#8A8A8A",
      "#979797",
      "#828282",
    ],
  };
  const keys = [
    "--water-top",
    "--water-mid",
    "--water-bottom",
    "--surface-base",
    "--surface-raised",
    "--surface-soft",
  ] as const;
  for (const [background, expected] of Object.entries(fixtures)) {
    const palette = compileTheme(background);
    assert.deepEqual(
      keys.map((key) => palette.tokens[key]),
      expected,
    );
  }
});
