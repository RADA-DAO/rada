import assert from "node:assert/strict";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const parsed = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync("infra/cloudflare/wrangler.jsonc", "utf8"),
);
assert.equal(parsed.error, undefined);
/** @type {unknown} */
const config = parsed.config;
assert.ok(
  config !== null &&
    typeof config === "object" &&
    "name" in config &&
    "preview_urls" in config &&
    "assets" in config,
);
assert.equal(config.name, "rada-staging");
assert.equal(config.preview_urls, false);
const assets = config.assets;
assert.ok(
  assets !== null &&
    typeof assets === "object" &&
    "not_found_handling" in assets &&
    "directory" in assets &&
    typeof assets.directory === "string",
);
assert.equal(assets.not_found_handling, "single-page-application");
assert.equal(
  resolve("infra/cloudflare", assets.directory),
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

/** @type {unknown} */
const manifest = JSON.parse(
  readFileSync("apps/miniapp/dist/tonconnect-manifest.json", "utf8"),
);
assert.ok(
  manifest !== null &&
    typeof manifest === "object" &&
    "iconUrl" in manifest &&
    typeof manifest.iconUrl === "string" &&
    "url" in manifest &&
    typeof manifest.url === "string",
);
assert.equal(new URL(manifest.iconUrl).pathname, "/wallet-icon.png");
assert.equal(
  new URL(manifest.url).origin,
  process.env.VITE_TON_CONNECT_APP_ORIGIN ?? "https://staging.example.invalid",
);
const icon = readFileSync("apps/miniapp/dist/wallet-icon.png");
assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(icon.readUInt32BE(16), 180);
assert.equal(icon.readUInt32BE(20), 180);
