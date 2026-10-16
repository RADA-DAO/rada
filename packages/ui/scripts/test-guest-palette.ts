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
    .replace(/(\.\d*?[1-9])0+(?=[)\s;,]|$)/g, "$1");

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
