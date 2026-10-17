import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAppCapability,
  appCapabilitiesAdapter,
} from "./app-capabilities.ts";
import { parseAppManifest } from "./app-manifest.ts";
const manifest = {
  name: "Game",
  author: "Fixture",
  designRoute: "standard",
  minPlatformVersion: "1.0.0",
  permissions: ["scores"],
  boards: { points: { min: 0, max: 100 } },
};
void test("reviewable score declarations require bounded boards", () => {
  assert.deepEqual(parseAppManifest(manifest).boards, manifest.boards);
  for (const boards of [
    undefined,
    null,
    {},
    { points: { min: 3, max: 2 } },
    { points: { min: 0.5, max: 2 } },
    { points: { min: 0, max: 1e10 } },
    { points: { min: 0, max: 2, extra: true } },
    { "bad/name": { min: 0, max: 2 } },
  ]) {
    assert.throws(
      () => parseAppManifest({ ...manifest, boards }),
      /invalid_manifest/,
    );
  }
  assert.throws(
    () => parseAppManifest({ ...manifest, permissions: [] }),
    /invalid_manifest/,
  );
});
void test("bridge rechecks reviewer permission and live consent on every records/score operation", async () => {
  let calls = 0;
  let consent = true;
  const options = {
    type: "rada.member.records.put",
    payload: { key: "progress", value: {}, version: 0 },
    appId: "fixture.game",
    hash: "a".repeat(64),
    granted: new Set(["storage.self"]),
    readConsent: () => Promise.resolve(consent),
    request: () => Promise.resolve(++calls),
  };
  assert.equal(await runAppCapability(options), 1);
  consent = false;
  await assert.rejects(runAppCapability(options), /capability_denied/);
  consent = true;
  await assert.rejects(
    runAppCapability({ ...options, granted: new Set() }),
    /capability_denied/,
  );
  await assert.rejects(
    runAppCapability({ ...options, type: "rada.member.scores.submit" }),
    /capability_denied/,
  );
  await assert.rejects(
    runAppCapability({ ...options, type: "rada.member.records.other" }),
    /capability_denied/,
  );
  assert.equal(calls, 1);
});
void test("credential adapter constrains endpoints and preserves actionable CAS failures", async () => {
  const old = globalThis.fetch;
  let request: Request | undefined;
  globalThis.fetch = (url, options) => {
    request = new Request(url, options);
    return Promise.resolve(
      Response.json({ error: "version_conflict" }, { status: 409 }),
    );
  };
  try {
    const api = appCapabilitiesAdapter("https://platform.example", () => ({
      Authorization: "tma synthetic",
    }));
    await assert.rejects(
      api.appCapability("fixture", "a".repeat(64), "records.put", {}),
      /version_conflict/,
    );
    assert.equal(request?.headers.get("Authorization"), "tma synthetic");
    assert.equal(
      request.url,
      "https://platform.example/apps/fixture/capabilities/records.put",
    );
    await assert.rejects(
      api.appCapability("../me", "a".repeat(64), "records.put", {}),
      /invalid_request/,
    );
  } finally {
    globalThis.fetch = old;
  }
});
