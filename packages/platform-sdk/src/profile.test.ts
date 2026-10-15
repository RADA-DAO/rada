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
test("own collection decoder rejects identity leakage, remote art and malformed metadata", async () => {
  const original = globalThis.fetch;
  let response: unknown;
  const adapter = profileAdapter("/api/me", () => ({
    Authorization: "tma fixture",
  }));
  globalThis.fetch = async (_input, options) => {
    assert.equal(options?.credentials, "omit");
    assert.equal(options?.cache, "no-store");
    return Response.json(response);
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
