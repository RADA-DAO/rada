import assert from "node:assert/strict";
import test from "node:test";
import { readdir } from "node:fs/promises";
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
  const fontNames = (await readdir("packages/ui/src/fonts")).filter((name) =>
    name.endsWith(".woff2"),
  );
  const fonts = files.filter((file) => file.name.endsWith(".woff2"));
  assert.equal(fonts.length, fontNames.length);
  const css = files.filter((file) => file.name.endsWith(".css"));
  assert.ok(css.length > 0);
  for (const file of css)
    assert.doesNotMatch(file.code, /data:\s*font|data:[^)]*;base64/i);
  for (const name of fontNames) {
    const stem = name.slice(0, -".woff2".length);
    const asset = fonts.find((file) =>
      new RegExp(`^assets/${stem}-[\\w-]+\\.woff2$`).test(file.name),
    );
    assert.ok(asset, `missing hashed asset for ${name}`);
    assert.ok(css.some((file) => file.code.includes(`/${asset.name}`)));
  }
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
