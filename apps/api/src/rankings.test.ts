import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
import type { IdentityStore } from "../../../modules/identity/index.ts";

Deno.test(
  "holders are public in production and guarded before storage in staging",
  async () => {
    let calls = 0;
    const identity: IdentityStore = {
      me: () => Promise.reject(new Error("unused")),
      ownFrogs: () => Promise.resolve([]),
      selectFrog: () => Promise.resolve(false),
      consents: () => Promise.resolve([]),
      setConsent: () => Promise.resolve(false),
    };
    const store = {
      page: () => {
        calls++;
        return Promise.resolve({ revision: "a".repeat(32), entries: [] });
      },
    };
    const build = (staging: boolean) =>
      createApp(
        FIXTURE_TOKEN,
        identity,
        [],
        undefined,
        staging,
        undefined,
        undefined,
        undefined,
        undefined,
        {},
        undefined,
        undefined,
        store,
      );
    const production = await build(false).request(
      "/v1/rankings/holders?token=TON",
    );
    assert(production.status === 200);
    assert(production.headers.get("cache-control") === "no-store");
    assert(calls === 1);
    const staging = build(true);
    assert(
      (await staging.request("/v1/rankings/holders?token=TON")).status === 401,
    );
    assert(calls === 1);
    const allowed = await staging.request("/v1/rankings/holders?token=JPEGPE", {
      headers: { authorization: `tma ${await signed()}` },
    });
    assert(allowed.status === 200);
    assert(Number(calls) === 2);
  },
);
