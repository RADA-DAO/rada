import { test } from "node:test";
import assert from "node:assert/strict";
import { profileAdapter } from "./profile.ts";
const frog = {
  frog_id: "00000000-0000-4000-8000-000000000011",
  username: "Fixture",
  background_color: "#000000",
  accent_color: "#FFFFFF",
  artwork_path: null,
};
await test("own collection decoder rejects identity leakage, remote art and malformed metadata", async () => {
  const original = globalThis.fetch;
  let response: unknown;
  const adapter = profileAdapter("/api/me", () => ({
    Authorization: "tma fixture",
  }));
  globalThis.fetch = (_input, options) => {
    assert.equal(options?.credentials, "omit");
    assert.equal(options.cache, "no-store");
    return Promise.resolve(Response.json(response));
  };
  try {
    response = { frogs: [frog] };
    assert.deepEqual(await adapter.readOwnFrogs(), [frog]);
    for (const invalid of [
      { ...frog, owner_subject_id: "private" },
      { ...frog, background_proof: {} },
      { ...frog, artwork_path: "https://untrusted.example/art.png" },
      { ...frog, artwork_path: "/media/jpegpe/invalid.svg" },
      { ...frog, background_color: "red" },
      { ...frog, frog_id: "bad" },
    ]) {
      response = { frogs: [invalid] };
      await assert.rejects(adapter.readOwnFrogs(), /unavailable/);
    }
    response = { frogs: [frog, frog] };
    await assert.rejects(adapter.readOwnFrogs(), /unavailable/);
    response = { frogs: [], owner_subject_id: "private" };
    await assert.rejects(adapter.readOwnFrogs(), /unavailable/);
    response = { selected: true };
    await adapter.selectProfileFrog(frog.frog_id);
    await adapter.selectProfileFrog(null);
    response = { selected: true, owner_subject_id: "private" };
    await assert.rejects(adapter.selectProfileFrog(null), /unavailable/);
    await assert.rejects(
      adapter.selectProfileFrog("invalid"),
      /invalid_request/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

await test("profile and collection accept optional canonical artwork URLs without allowing extra fields", async () => {
  const original = globalThis.fetch;
  const adapter = profileAdapter("/api/me", () => ({
    Authorization: "tma fixture",
  }));
  const { artwork_path, ...publicFrog } = frog;
  const artworkUrl = `/v1/frogs/${frog.frog_id}/artwork/${"a".repeat(64)}`;
  let response: unknown;
  globalThis.fetch = () => Promise.resolve(Response.json(response));
  try {
    for (const fields of [
      {},
      { artwork_url: null },
      { artwork_url: artworkUrl },
    ]) {
      const selected = { ...publicFrog, ...fields };
      response = {
        subject_id: "fixture-subject",
        profile: { visibility: "public", public: selected },
        membership: { status: "unavailable" },
      };
      assert.deepEqual(await adapter.readOwnProfile(), response);
      const owned = { ...selected, artwork_path };
      response = { frogs: [owned] };
      assert.deepEqual(await adapter.readOwnFrogs(), [owned]);
    }
    for (const fields of [
      { artwork_url: 42 },
      { artwork_url: "https://untrusted.example/art.png" },
      { artwork_url: `//untrusted.example${artworkUrl}` },
      {
        artwork_url: artworkUrl.replace(
          frog.frog_id,
          "00000000-0000-4000-8000-000000000012",
        ),
      },
      { artwork_url: `${artworkUrl}?token=secret` },
      { artwork_url: artworkUrl.slice(0, -1) },
      { artwork_url: artworkUrl, owner_subject_id: "private" },
    ]) {
      response = {
        subject_id: "fixture-subject",
        profile: { visibility: "public", public: { ...publicFrog, ...fields } },
        membership: { status: "unavailable" },
      };
      await assert.rejects(adapter.readOwnProfile(), /unavailable/);
      response = { frogs: [{ ...frog, ...fields }] };
      await assert.rejects(adapter.readOwnFrogs(), /unavailable/);
    }
  } finally {
    globalThis.fetch = original;
  }
});
