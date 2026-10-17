import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { encodePng } from "../../splash/png.ts";
import { registerArtworkRoutes } from "./artwork-router.ts";
import type { ServedArtwork } from "./artwork-store.ts";
const id = "10000000-0000-4000-8000-000000000001";
const bytes = encodePng({
  width: 1,
  height: 1,
  rgba: new Uint8Array([1, 2, 3, 255]),
});
const digest = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const png: ServedArtwork = {
  bytes,
  contentType: "image/png",
  needsNormalization: false,
  sha256: digest(bytes),
  isPublic: true,
};
function setup(image = png, staging = false) {
  const app = new Hono();
  registerArtworkRoutes(
    app,
    {
      image: (_id, viewer) =>
        Promise.resolve(
          _id === id && (image.isPublic || viewer === "owner") ? image : null,
        ),
      references: () => Promise.resolve([]),
    },
    (c) => Promise.resolve(c.req.header("Authorization") ?? null),
    staging,
  );
  return app;
}
const path = `/v1/frogs/${id}/artwork`;
test("public PNG, immutable content hash, hardening and HEAD", async () => {
  const app = setup();
  const url = `${path}/${png.sha256}`;
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(
    response.headers.get("Cache-Control"),
    "public, max-age=31536000, immutable",
  );
  assert.equal(response.headers.get("ETag"), `"${png.sha256}"`);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(
    response.headers.get("Content-Security-Policy"),
    "default-src 'none'",
  );
  assert.equal(
    response.headers.get("Cross-Origin-Resource-Policy"),
    "cross-origin",
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const head = await app.request(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("Content-Length"), String(bytes.length));
  assert.equal(await head.text(), "");
  assert.equal(
    (await app.request(path)).headers.get("Cache-Control"),
    "no-store",
  );
  assert.equal(
    (
      await app.request(url, {
        headers: { "If-None-Match": `W/"${png.sha256}"` },
      })
    ).status,
    304,
  );
});
test("hash mismatch, malformed id and corrupted stored checksum fail closed", async () => {
  assert.equal(
    (await setup().request(`${path}/${"0".repeat(64)}`)).status,
    404,
  );
  assert.equal((await setup().request("/v1/frogs/no/artwork")).status, 404);
  assert.equal(
    (await setup({ ...png, sha256: "0".repeat(64) }).request(path)).status,
    404,
  );
});
test("private artwork is owner-only, including conditional requests and HEAD", async () => {
  const app = setup({ ...png, isPublic: false });
  for (const method of ["GET", "HEAD"]) {
    assert.equal((await app.request(path, { method })).status, 404);
    assert.equal(
      (
        await app.request(path, {
          method,
          headers: { Authorization: "other", "If-None-Match": "*" },
        })
      ).status,
      404,
    );
    const own = await app.request(`${path}/${png.sha256}`, {
      method,
      headers: { Authorization: "owner" },
    });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get("Cache-Control"), "no-store");
  }
});
test("legacy JPEG requires matching type, frame, scan, terminal EOI and bounded dimensions", async () => {
  // Minimal marker envelope; pixel decoding is deliberately not claimed.
  const jpeg = new Uint8Array([
    255, 216, 255, 192, 0, 11, 8, 0, 32, 0, 32, 1, 1, 17, 0, 255, 218, 0, 8, 1,
    1, 0, 0, 63, 0, 1, 255, 217,
  ]);
  const image: ServedArtwork = {
    ...png,
    bytes: jpeg,
    sha256: digest(jpeg),
    contentType: "image/jpeg",
    needsNormalization: true,
  };
  const response = await setup(image).request(path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "image/jpeg");
  for (const invalid of [
    { ...image, contentType: "image/png" },
    { ...image, needsNormalization: false },
    { ...image, bytes: new TextEncoder().encode("<svg onload='alert(1)'/>") },
    { ...image, bytes: jpeg.slice(0, -2) },
    { ...image, bytes: new Uint8Array([...jpeg, 0]) },
    { ...image, bytes: new Uint8Array(4194305) },
  ])
    assert.equal(
      (await setup({ ...invalid, sha256: digest(invalid.bytes) }).request(path))
        .status,
      404,
    );
});
test("staging disables public caching and request budget bounds misses", async () => {
  assert.equal(
    (await setup(png, true).request(`${path}/${png.sha256}`)).headers.get(
      "Cache-Control",
    ),
    "no-store",
  );
  const app = setup();
  for (let i = 0; i < 200; i++) await app.request("/v1/frogs/no/artwork");
  const response = await app.request(path);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
});
