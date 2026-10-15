import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import {
  PostgresWalletStore,
  JPEGPE_JETTON_MASTER,
} from "../../../modules/wallet/index.ts";
import { walletProof } from "./fixtures/wallet-proof.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

Deno.test(
  "wallet proof, replay, consent revocation and cached chain balances through PostgreSQL",
  async () => {
    const databaseUrl = Deno.env.get("API_TEST_DATABASE_URL");
    if (
      !databaseUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("Disposable local database required");
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pools: pg.Pool[] = [];
    const originalFetch = globalThis.fetch;
    let networkCalls = 0;
    try {
      await admin.query(
        "CREATE ROLE wallet_fixture_auth LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_auth TO wallet_fixture_auth; CREATE ROLE wallet_fixture_identity LOGIN PASSWORD 'fixture-only' INHERIT; GRANT identity_service TO wallet_fixture_identity; CREATE ROLE wallet_fixture_service LOGIN PASSWORD 'fixture-only' INHERIT; GRANT wallet_service TO wallet_fixture_service;",
      );
      const pool = (username: string) => {
        const url = new URL(databaseUrl);
        url.username = username;
        url.password = "fixture-only";
        const result = new pg.Pool({ connectionString: url.toString() });
        pools.push(result);
        return result;
      };
      const auth = pool("wallet_fixture_auth");
      const identity = new PostgresIdentityStore(
        auth,
        pool("wallet_fixture_identity"),
      );
      globalThis.fetch = (input) => {
        const url = new URL(String(input));
        assert(url.origin === "https://tonapi.io");
        networkCalls++;
        return Promise.resolve(
          Response.json(
            url.pathname.endsWith("/jettons")
              ? {
                  balances: [
                    {
                      balance: "12345678901234567890",
                      jetton: { address: JPEGPE_JETTON_MASTER, decimals: 9 },
                    },
                  ],
                }
              : { balance: "900719925474099312345" },
          ),
        );
      };
      const store = new PostgresWalletStore(
        auth,
        pool("wallet_fixture_service"),
        "wallet.fixture.example",
      );
      const app = createApp(
        FIXTURE_TOKEN,
        identity,
        [],
        undefined,
        false,
        undefined,
        undefined,
        store,
      );
      const headers = {
        authorization: `tma ${await signed()}`,
        "content-type": "application/json",
      };
      const secondHeaders = {
        ...headers,
        authorization: `tma ${await signed({ user: JSON.stringify({ id: 102 }) })}`,
      };
      const post = (path: string, body?: unknown, ownHeaders = headers) =>
        app.request(path, {
          method: "POST",
          headers: ownHeaders,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const issue = async () => {
        const response = await post("/me/wallet/challenge");
        assert(response.status === 200);
        return ((await response.json()) as { payload: string }).payload;
      };
      const payload = await issue();
      const proof = walletProof(payload);
      assert(
        (await post("/me/wallet/link", proof, secondHeaders)).status === 409,
      );
      assert(
        (await post("/me/wallet/link", { ...proof, publicKey: "0".repeat(64) }))
          .status === 400,
      );
      const results = await Promise.all([
        post("/me/wallet/link", proof),
        post("/me/wallet/link", proof),
      ]);
      assert(
        results
          .map((r) => r.status)
          .sort()
          .join(",") === "200,409",
      );
      assert((await post("/me/wallet/link", proof)).status === 409);
      const expired = await issue();
      await admin.query(
        "UPDATE wallet.challenges SET created_at = now() - interval '20 minutes', expires_at = now() - interval '10 minutes' WHERE payload=$1",
        [expired],
      );
      assert(
        (await post("/me/wallet/link", walletProof(expired))).status === 409,
      );
      const old = await issue();
      const replacement = await issue();
      assert((await post("/me/wallet/link", walletProof(old))).status === 409);
      assert(
        (await post("/me/wallet/link", walletProof(replacement, undefined, 8)))
          .status === 200,
      );
      assert((await store.own("101")).length === 2);
      assert((await store.own("102")).length === 0);
      const appId = "fixture.wallet";
      const read = (type: string) =>
        app.request(`/apps/${appId}/wallet/${type}`, { headers });
      assert((await read("balances")).status === 403 && networkCalls === 0);
      await identity.setConsent("101", appId, "wallet.balances.read", true);
      const balances = await read("balances");
      const balancesBody = await balances.json();
      assert(balances.status === 200 && balancesBody.wallets.length === 2);
      assert(balancesBody.wallets[0].tonNano === "900719925474099312345");
      assert(!JSON.stringify(balancesBody).includes("address"));
      const calls = networkCalls;
      assert((await read("balances")).status === 200 && networkCalls === calls);
      await identity.setConsent("101", appId, "wallet.balances.read", false);
      assert((await read("balances")).status === 403 && networkCalls === calls);
      assert((await read("address")).status === 403);
      await identity.setConsent("101", appId, "wallet.address.read", true);
      const addresses = await read("address");
      assert(addresses.status === 200);
      assert(!JSON.stringify(await addresses.json()).includes("tonNano"));
      assert(
        (
          await post(
            "/me/wallet/revoke",
            { address: proof.address },
            secondHeaders,
          )
        ).status === 200,
      );
      assert((await store.own("101")).length === 2);
      assert(
        (await post("/me/wallet/revoke", { address: proof.address })).status ===
          200,
      );
      assert((await store.own("101")).length === 1);
      assert(
        (await store.history("101")).filter((e) => e.action === "revoked")
          .length === 1,
      );
      assert((await store.history("102")).length === 0);
      await store.revoke(
        "101",
        walletProof("a".repeat(64), undefined, 8).address,
      );
      assert((await store.own("101")).length === 0);
      assert(
        (
          await post("/me/wallet/challenge", undefined, {
            ...headers,
            authorization: `tma ${await signed({ auth_date: String(Math.floor(Date.now() / 1000) - 3601) })}`,
          })
        ).status === 401,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query(
        "DROP ROLE IF EXISTS wallet_fixture_auth; DROP ROLE IF EXISTS wallet_fixture_identity; DROP ROLE IF EXISTS wallet_fixture_service;",
      );
      await admin.end();
    }
  },
);
