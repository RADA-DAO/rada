import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const parsed = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync("infra/cloudflare/wrangler.jsonc", "utf8"),
);
assert.equal(parsed.error, undefined);
const config = parsed.config;
assert.equal(config.name, "rada-staging");
assert.equal(config.preview_urls, false);
assert.equal(config.assets.not_found_handling, "single-page-application");
assert.equal(
  resolve("infra/cloudflare", config.assets.directory),
  resolve("apps/miniapp/dist"),
);
const source = readFileSync("apps/miniapp/public/_headers", "utf8");
const headers = readFileSync("apps/miniapp/dist/_headers", "utf8");
assert.equal(headers, source);
assert.match(headers, /^\/\*\n\s+Content-Security-Policy:.*frame-src 'none'/m);
assert.match(headers, /X-Content-Type-Options: nosniff/);
assert.match(
  readFileSync("apps/miniapp/dist/index.html", "utf8"),
  /frame-src 'none'/,
);
console.log("Worker assets and sandbox response headers passed.");
