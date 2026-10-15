import test from "node:test";
import assert from "node:assert/strict";
import { parseAppManifest } from "./app-manifest.ts";
import { mountAppHost, verifyAppArtifact } from "./app-host.ts";

const valid = {
  name: "Example",
  author: "Author",
  trustLevel: "community",
  designRoute: "standard",
  permissions: ["identity.self.read", "wallet.address.read"],
  minPlatformVersion: "1.0.0",
};
test("manifest rejects unknown, coercible and future declarations", () => {
  assert.deepEqual(parseAppManifest(valid).permissions, valid.permissions);
  for (const change of [
    { trustLevel: ["official"] },
    { designRoute: ["free-style"] },
    { permissions: ["wallet.address.read", "wallet.address.read"] },
    { permissions: ["admin"] },
    { minPlatformVersion: "2.0.0" },
    { name: "<script>" },
    { extra: true },
  ])
    assert.throws(() => parseAppManifest({ ...valid, ...change }));
});
test("artifact bytes require exact SHA-256", async () => {
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
test("host rejects forged release grants before artifact fetch", async () => {
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
