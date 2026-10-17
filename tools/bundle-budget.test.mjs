import test from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { compare, measure, metrics } from "./bundle-budget.mjs";

const limits = Object.fromEntries(metrics.map((metric) => [metric, 100]));

await test("comparison accepts exact limits and zero-sized categories", () => {
  const actual = { ...limits, fonts: 0 };
  assert.equal(
    compare({ "index.html": actual }, { "index.html": actual }).passed,
    true,
  );
});

await test("each category fails independently at one byte over budget", () => {
  for (const metric of metrics) {
    const result = compare(
      { "index.html": { ...limits, [metric]: 101 } },
      { "index.html": limits },
    );
    assert.equal(result.passed, false);
    assert.equal(result.rows.filter((row) => row.status === "OVER").length, 1);
    assert.equal(
      result.rows.find((row) => row.status === "OVER")?.metric,
      metric,
    );
  }
});

await test("new and removed entries require deliberate budget changes", () => {
  assert.equal(
    compare({ "new.html": limits }, { "index.html": limits }).passed,
    false,
  );
  assert.equal(
    compare(
      { "index.html": limits },
      { "index.html": limits, "old.html": limits },
    ).passed,
    false,
  );
  assert.equal(compare({}, {}).passed, false);
});

await test("missing and invalid budgets fail closed", () => {
  for (const invalid of [undefined, null, -1, 1.5, "100", Infinity, NaN]) {
    assert.equal(
      compare(
        { "index.html": limits },
        {
          "index.html": { ...limits, fonts: invalid },
        },
      ).passed,
      false,
    );
  }
  assert.equal(compare({ "index.html": limits }, {}).passed, false);
  assert.throws(() => compare({ "index.html": limits }, null), /Budget must/);
});

await test("measurement traverses static and nested dynamic imports, deduplicating shared files", () => {
  const manifest = {
    "index.html": {
      file: "entry.js",
      isEntry: true,
      imports: ["shared"],
      dynamicImports: ["lazy", "lazy"],
    },
    shared: {
      file: "shared.js",
      imports: ["index.html"],
      css: ["shared.css"],
      dynamicImports: ["nested"],
    },
    lazy: {
      file: "lazy.js",
      imports: ["shared", "lazyShared"],
      dynamicImports: ["nested"],
      css: ["shared.css", "lazy.css"],
    },
    lazyShared: { file: "lazy-shared.js" },
    nested: { file: "nested.js", imports: ["lazyShared"] },
    "other.html": { file: "other.js", isEntry: true },
    unrelated: { file: "unrelated.js" },
  };
  const read = (/** @type {string} */ file) => Buffer.from(file.repeat(20));
  const report = measure(manifest, read, ["font.woff2", "font.woff2"]);
  const actual = report.entries["index.html"];
  assert.ok(actual);
  const initial = ["entry.js", "shared.js"].map(read);
  const lazy = ["lazy.js", "lazy-shared.js", "nested.js"].map(read);
  const sumGzip = (/** @type {Buffer[]} */ buffers) =>
    buffers.reduce((sum, data) => sum + gzipSync(data, { level: 9 }).length, 0);
  const sumBrotli = (/** @type {Buffer[]} */ buffers) =>
    buffers.reduce((sum, data) => sum + brotliCompressSync(data).length, 0);
  assert.deepEqual(actual, {
    initialJsGzip: sumGzip(initial),
    initialJsBrotli: sumBrotli(initial),
    initialCss: read("shared.css").length,
    fonts: read("font.woff2").length,
    lazyJsGzip: sumGzip(lazy),
    lazyJsBrotli: sumBrotli(lazy),
    lazyCss: read("lazy.css").length,
  });
  assert.equal(report.lazyChunks.length, 3);
  assert.equal(
    report.entries["other.html"]?.initialJsGzip,
    sumGzip([read("other.js")]),
  );
});

await test("missing build entries, broken imports and missing files fail", () => {
  assert.throws(
    () => measure({}, () => Buffer.alloc(0)),
    /No production entries/,
  );
  assert.throws(
    () =>
      measure(
        { index: { file: "a.js", isEntry: true, imports: ["missing"] } },
        () => Buffer.alloc(0),
      ),
    /Missing manifest import/,
  );
  assert.throws(
    () =>
      measure({ index: { file: "missing.js", isEntry: true } }, () => {
        throw new Error("missing file");
      }),
    /missing file/,
  );
});
