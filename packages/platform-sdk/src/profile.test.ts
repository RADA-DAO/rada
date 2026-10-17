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

await test("frog detail rejects private fields and artwork cannot redirect credentials", async () => {
  const { frogAdapter, parseFrogDetails } = await import("./frog-details.ts");
  const detail = {
    creator: null,
    owner: "PublicFrog",
    colour_source: "legacy_unverified",
    history: [{ at: "2026-01-01T00:00:00Z", from: null, to: "PublicFrog" }],
  };
  assert.deepEqual(parseFrogDetails(detail), detail);
  assert.throws(() => parseFrogDetails({ ...detail, subject_id: "private" }));
  assert.throws(() =>
    parseFrogDetails({
      ...detail,
      history: [{ ...detail.history[0], wallet: "private" }],
    }),
  );
  const adapter = frogAdapter("https://api.example/me", () => ({
    Authorization: "tma fixture",
  }));
  await assert.rejects(
    adapter.readFrogArtwork(
      "https://evil.example/art",
      new AbortController().signal,
    ),
    /invalid_artwork/,
  );
});

await test("artwork uses the configured API, keeps auth private and honors HTTP caching", async (context) => {
  const { frogAdapter } = await import("./frog-details.ts");
  const path = `/v1/frogs/${frog.frog_id}/artwork/${"a".repeat(64)}`;
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  context.mock.method(
    globalThis,
    "fetch",
    (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return Promise.resolve(
        new Response(new Uint8Array([1]), {
          headers: { "Content-Type": "image/png" },
        }),
      );
    },
  );
  const adapter = frogAdapter("https://api.example/me", () => ({
    Authorization: "tma fixture",
  }));
  const controller = new AbortController();
  const blob = await adapter.readFrogArtwork(path, controller.signal);
  assert.equal(blob.type, "image/png");
  assert.ok(requests[0]?.init);
  assert.equal(requests[0].url, `https://api.example${path}`);
  assert.equal(requests[0].init.cache, "default");
  assert.equal(requests[0].init.credentials, "omit");
  assert.equal(requests[0].init.redirect, "error");
  assert.deepEqual(requests[0].init.headers, {
    Authorization: "tma fixture",
  });
  controller.abort();
  await assert.rejects(adapter.readFrogArtwork(path, controller.signal));
  assert.equal(requests.length, 1);
});
