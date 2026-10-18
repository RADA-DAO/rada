import test from "node:test";
import assert from "node:assert/strict";
import { appIconUrl, parseAppManifest } from "./app-manifest.ts";
import { mountAppHost, verifyAppArtifact } from "./app-host.ts";

const valid = {
  name: "Example",
  author: "Author",
  trustLevel: "community",
  designRoute: "standard",
  permissions: ["identity.self.read", "wallet.address.read"],
  minPlatformVersion: "1.0.0",
};
await test("manifest rejects unknown, coercible and future declarations", () => {
  assert.deepEqual(parseAppManifest(valid).permissions, valid.permissions);
  for (const change of [
    { trustLevel: ["official"] },
    // An author cannot declare official status; it is a registry decision.
    { trustLevel: "official" },
    { trustLevel: "platform" },
    { designRoute: ["free-style"] },
    { permissions: ["wallet.address.read", "wallet.address.read"] },
    { permissions: ["admin"] },
    { minPlatformVersion: "2.0.0" },
    { name: "<script>" },
    { extra: true },
  ])
    assert.throws(() => parseAppManifest({ ...valid, ...change }));
});
await test("a community declaration is accepted but dropped, and none is required", () => {
  assert.equal("trustLevel" in parseAppManifest(valid), false);
  const without: Record<string, unknown> = { ...valid };
  delete without.trustLevel;
  assert.deepEqual(parseAppManifest(without), without);
});
await test("manifest icon is an optional relative image path inside the artifact", () => {
  for (const icon of ["icon.png", "img/icon.webp", "a/b/c.svg", "x-1_2.png"])
    assert.equal(parseAppManifest({ ...valid, icon }).icon, icon);
  assert.equal("icon" in parseAppManifest(valid), false);
  for (const icon of [
    "/icon.png",
    "../icon.png",
    "a/../b.png",
    ".hidden.png",
    "https://evil.example/icon.png",
    "//evil.example/icon.png",
    "icon.gif",
    "icon.PNG",
    "icon.png?x=1",
    "icon.png#x",
    "a/b/c/d.png",
    "icon\\x.png",
    "",
    42,
    ["icon.png"],
  ])
    assert.throws(
      () => parseAppManifest({ ...valid, icon }),
      /invalid_manifest/,
    );
  assert.equal(
    appIconUrl(
      { icon: "img/icon.png" },
      `https://artifacts.example/artifacts/${"a".repeat(64)}.html`,
      "a".repeat(64),
    ),
    `https://artifacts.example/artifacts/${"a".repeat(64)}/img/icon.png`,
  );
  assert.equal(
    appIconUrl({}, "https://artifacts.example/x.html", "a"),
    undefined,
  );
});
await test("artifact bytes require exact SHA-256", async () => {
  const bytes = new TextEncoder().encode("<h1>safe</h1>");
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(
    await verifyAppArtifact(new Response(bytes), hash),
    "<h1>safe</h1>",
  );
  await assert.rejects(
    verifyAppArtifact(new Response(bytes), "0".repeat(64)),
    /artifact_integrity_failed/,
  );
  await assert.rejects(
    verifyAppArtifact(new Response(new Uint8Array(1024 * 1024 + 1)), hash),
    /artifact_too_large/,
  );
});
await test("host rejects forged release grants before artifact fetch", async () => {
  const base = {
    appId: "example",
    manifest: valid,
    artifactUrl: "https://artifacts.example/app.html",
    artifactSha256: "0".repeat(64),
    grantedPermissions: ["identity.self.read"],
  };
  for (const change of [
    { grantedPermissions: "identity.self.read" },
    { grantedPermissions: ["identity.self.read", "identity.self.read"] },
    { grantedPermissions: ["governance.vote"] },
    { grantedPermissions: [["identity.self.read"]] },
    { artifactSha256: "not-a-hash" },
    { artifactUrl: "https://user:pass@artifacts.example/app.html" },
  ])
    await assert.rejects(
      mountAppHost({
        release: { ...base, ...change },
        artifactOrigin: "https://artifacts.example",
      } as never),
    );
});

await test("review queue validates immutable releases and strips private metadata", async () => {
  const { parseReviewQueue } = await import("./review-registry.ts");
  const row = {
    appId: "example.app",
    versionId: "00000000-0000-4000-8000-000000000001",
    versionNo: 1,
    manifest: valid,
    sha256: "a".repeat(64),
    artifactUrl: `https://artifacts.example/artifacts/${"a".repeat(64)}.html`,
    authorId: "private-subject",
    createdAt: "fixture",
  };
  const projected = parseReviewQueue({ versions: [row] })[0];
  assert.ok(projected);
  assert.equal(projected.artifactSha256, row.sha256);
  assert.equal("authorId" in projected, false);
  assert.equal("createdAt" in projected, false);
  for (const change of [
    { appId: "../app" },
    { versionId: "bad" },
    { versionNo: "1" },
    { versionNo: 0 },
    { versionNo: 1.5 },
    { sha256: "A".repeat(64) },
    { artifactUrl: row.artifactUrl + "?token=bad" },
    { artifactUrl: row.artifactUrl.replace("https:", "http:") },
    {
      artifactUrl: row.artifactUrl.replace(
        "artifacts.example",
        "user:password@artifacts.example",
      ),
    },
    { manifest: { ...valid, permissions: ["unknown"] } },
    { grantedPermissions: ["wallet.sign"] },
  ])
    assert.throws(() =>
      parseReviewQueue({ versions: [{ ...row, ...change }] }),
    );
  for (const input of [
    null,
    { versions: {} },
    { versions: [], extra: true },
    { versions: Array(1001).fill(row) },
  ])
    assert.throws(() => parseReviewQueue(input));
});
await test("reviewed manifest category is optional and limited to apps or games", () => {
  for (const category of ["apps", "games"])
    assert.equal(parseAppManifest({ ...valid, category }).category, category);
  for (const category of [null, "official", "rada", [], 1])
    assert.throws(() => parseAppManifest({ ...valid, category }));
});
