import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePublishedApps, publishedAppsAdapter } from "./published-apps.ts";

const sha256 = "a".repeat(64);
const row = {
  appId: "fixture.app",
  registryId: "00000000-0000-4000-8000-000000000001",
  versionId: "00000000-0000-4000-8000-000000000002",
  versionNo: 1,
  manifest: {
    name: "Fixture",
    author: "Fixture author",
    trustLevel: "community",
    designRoute: "standard",
    permissions: ["identity.self.read", "wallet.sign"],
    minPlatformVersion: "1.0.0",
  },
  sha256,
  artifactUrl: `https://artifacts.example/artifacts/${sha256}.html`,
  grantedPermissions: ["identity.self.read"],
};

await test("published list keeps valid releases and drops malformed rows", () => {
  const [app, ...rest] = parsePublishedApps({ apps: [row] });
  assert.equal(rest.length, 0);
  assert.deepEqual(app, {
    appId: "fixture.app",
    versionId: row.versionId,
    manifest: row.manifest,
    artifactUrl: row.artifactUrl,
    artifactSha256: sha256,
    grantedPermissions: ["identity.self.read"],
  });
  const [withIcon] = parsePublishedApps({
    apps: [{ ...row, manifest: { ...row.manifest, icon: "icon.png" } }],
  });
  assert.equal(
    withIcon?.iconUrl,
    `https://artifacts.example/artifacts/${sha256}/icon.png`,
  );
  assert.equal("iconUrl" in app, false);
  const invalid = [
    {
      ...row,
      manifest: { ...row.manifest, icon: "https://evil.example/i.png" },
    },
    { ...row, appId: "Bad id" },
    { ...row, versionId: "1" },
    { ...row, sha256: "b".repeat(64) },
    {
      ...row,
      artifactUrl: `http://artifacts.example/artifacts/${sha256}.html`,
    },
    { ...row, artifactUrl: `${row.artifactUrl}?x=1` },
    { ...row, manifest: { ...row.manifest, trustLevel: "platform" } },
    { ...row, manifest: { ...row.manifest, minPlatformVersion: "9.0.0" } },
    // A grant the manifest never requested, or a duplicate, is never trusted.
    { ...row, grantedPermissions: ["money.transfer"] },
    {
      ...row,
      grantedPermissions: ["identity.self.read", "identity.self.read"],
    },
    { ...row, ownerSubject: "private" },
    null,
  ];
  for (const value of invalid)
    assert.deepEqual(parsePublishedApps({ apps: [value, row] }), [app]);
  assert.equal(parsePublishedApps({ apps: [row, row] }).length, 1);
  for (const envelope of [null, [], { apps: {} }, { apps: [], extra: 1 }])
    assert.throws(() => parsePublishedApps(envelope), /unavailable/);
});

await test("published list read is authenticated, credential-free and mapped to errors", async () => {
  const original = globalThis.fetch;
  let status = 200;
  const urls: string[] = [];
  globalThis.fetch = (input, options) => {
    urls.push(input instanceof Request ? input.url : input.toString());
    assert.equal(options?.credentials, "omit");
    assert.equal(options.cache, "no-store");
    assert.deepEqual(options.headers, { Authorization: "tma fixture" });
    return Promise.resolve(Response.json({ apps: [row] }, { status }));
  };
  try {
    const adapter = publishedAppsAdapter("/api", () => ({
      Authorization: "tma fixture",
    }));
    assert.equal((await adapter.readPublishedApps()).length, 1);
    assert.deepEqual(urls, ["/api/apps/published"]);
    status = 401;
    await assert.rejects(adapter.readPublishedApps(), /expired/);
    status = 503;
    await assert.rejects(adapter.readPublishedApps(), /unavailable/);
    const guest = publishedAppsAdapter("/api", () => null);
    await assert.rejects(guest.readPublishedApps(), /expired/);
    assert.equal(urls.length, 3, "a guest read makes no request");
  } finally {
    globalThis.fetch = original;
  }
});
