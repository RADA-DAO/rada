import assert from "node:assert/strict";
import test from "node:test";
import { build } from "vite";

const marker = "catalogReady";

/** @param {"true" | "false"} catalog */
async function bundle(catalog) {
  process.env.CATALOG = catalog;
  try {
    const result = await build({
      configFile: "apps/miniapp/vite.config.ts",
      logLevel: "silent",
      build: { write: false },
    });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(
      (entry) => ("output" in entry ? entry.output : []),
    );
    return outputs.map((file) => ({
      name: file.fileName,
      code: file.type === "chunk" ? file.code : String(file.source),
    }));
  } finally {
    delete process.env.CATALOG;
  }
}

await test("the production bundle has no component catalog", async () => {
  const files = await bundle("false");
  assert.ok(files.some((file) => file.name === "index.html"));
  assert.deepEqual(
    files.filter(
      (file) => /catalog/i.test(file.name) || file.code.includes(marker),
    ),
    [],
  );
});

await test("the catalog build contains the catalog page", async () => {
  const files = await bundle("true");
  assert.ok(files.some((file) => file.name.endsWith("catalog.html")));
  assert.ok(files.some((file) => file.code.includes(marker)));
});
