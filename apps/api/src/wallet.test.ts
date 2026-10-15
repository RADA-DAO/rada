import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
import type { WalletStore } from "../../../modules/wallet/index.ts";

Deno.test(
  "wallet routes authenticate, scope app reads and reject malformed proof",
  async () => {
    let linkCalls = 0;
    const wallet: WalletStore = {
      challenge: (id) => {
        assert(id === "101");
        return Promise.resolve({
          payload: "a".repeat(64),
          expiresAt: new Date().toISOString(),
        });
      },
      link: () => {
        linkCalls++;
        return Promise.reject(new Error("unexpected"));
      },
      own: (id) => {
        assert(id === "101");
        return Promise.resolve([]);
      },
      history: () => Promise.resolve([]),
      revoke: () => Promise.resolve(false),
      ownBalances: () => Promise.resolve([]),
      appAddress: (id, appId) => {
        assert(id === "101" && appId === "fixture.app");
        return Promise.resolve(null);
      },
      appBalances: () => Promise.resolve(null),
    };
    const identity = {
      ownFrogs: () => Promise.resolve([]),
      selectFrog: () => Promise.resolve(false),
      consents: () => Promise.resolve([]),
      setConsent: () => Promise.resolve(false),
      me: () =>
        Promise.resolve({
          subject_id: "00000000-0000-4000-8000-000000000001",
          profile: { visibility: "private" as const, public: null },
          membership: { status: "unavailable" as const },
        }),
    };
    const app = createApp(
      FIXTURE_TOKEN,
      identity,
      [],
      undefined,
      false,
      undefined,
      undefined,
      wallet,
    );
    assert((await app.request("/me/wallet")).status === 401);
    const authorization = `tma ${await signed()}`;
    assert(
      (await app.request("/me/wallet", { headers: { authorization } }))
        .status === 200,
    );
    assert(
      (
        await app.request("/me/wallet/challenge", {
          method: "POST",
          headers: { authorization },
        })
      ).status === 200,
    );
    const denied = await app.request("/apps/fixture.app/wallet/address", {
      headers: { authorization },
    });
    assert(denied.status === 403);
    const malformed = await app.request("/me/wallet/link", {
      method: "POST",
      headers: { authorization, "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "0:" + "1".repeat(64),
        network: "-239",
        proof: { payload: "a".repeat(64) },
      }),
    });
    assert(malformed.status === 400 && linkCalls === 0);
  },
);
