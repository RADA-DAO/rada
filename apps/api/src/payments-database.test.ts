import pg from "pg";
import { createApp } from "./app.ts";
import { PostgresIdentityStore } from "../../../modules/identity/index.ts";
import { PostgresRegistryStore } from "../../../modules/apps/index.ts";
import {
  PaymentChain,
  type PaymentRecord,
  PostgresPaymentStore,
  PostgresWalletStore,
} from "../../../modules/wallet/index.ts";
import { walletProof } from "./fixtures/wallet-proof.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

class FixtureChain extends PaymentChain {
  signatures = 0;
  confirmed = false;
  override estimateFee() {
    return Promise.resolve({
      nano: "1234567",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
  }
  override async signRequest(intent: PaymentRecord) {
    this.signatures++;
    return await super.signRequest(intent);
  }
  override async confirmation(intent: PaymentRecord) {
    // Exercise the real receipt validator with a deterministic finalized fixture.
    const chain = new PaymentChain(() =>
      Promise.resolve(
        Response.json({
          transactions: this.confirmed
            ? [
                {
                  hash: "f".repeat(64),
                  account: intent.recipient,
                  finality: "finalized",
                  emulated: false,
                  mc_block_seqno: 1,
                  description: { aborted: false },
                  now: Math.floor(Date.now() / 1000),
                  in_msg: {
                    source: intent.sender,
                    destination: intent.recipient,
                    value: intent.amount,
                    bounced: false,
                    message_content: {
                      decoded: {
                        comment: `RADA:${intent.intentId}:${intent.purpose}`,
                      },
                    },
                  },
                },
              ]
            : [],
        }),
      ),
    );
    return await chain.confirmation(intent);
  }
}

Deno.test(
  "payment HTTP lifecycle, authorization and concurrent single claim through PostgreSQL",
  async () => {
    const databaseUrl = Deno.env.get("API_TEST_DATABASE_URL");
    if (
      !databaseUrl ||
      !["127.0.0.1", "localhost"].includes(new URL(databaseUrl).hostname)
    )
      throw new Error("Disposable local database required");
    const admin = new pg.Pool({ connectionString: databaseUrl });
    const pools: pg.Pool[] = [];
    const appId = "fixture.payments";
    const roles = ["auth", "identity", "wallet", "apps"];
    try {
      for (const role of roles) {
        const grant = role === "auth" ? "identity_auth" : `${role}_service`;
        await admin.query(
          `CREATE ROLE payments_fixture_${role} LOGIN PASSWORD 'fixture-only' INHERIT; GRANT ${grant} TO payments_fixture_${role}`,
        );
      }
      const pool = (role: string) => {
        const url = new URL(databaseUrl);
        url.username = `payments_fixture_${role}`;
        url.password = "fixture-only";
        const result = new pg.Pool({ connectionString: url.toString() });
        pools.push(result);
        return result;
      };
      const auth = pool("auth");
      const chain = new FixtureChain();
      const wallet = new PostgresWalletStore(
        auth,
        pool("wallet"),
        "wallet.fixture.example",
      );
      const app = createApp(
        FIXTURE_TOKEN,
        new PostgresIdentityStore(auth, pool("identity")),
        [],
        undefined,
        false,
        new PostgresRegistryStore(auth, pool("apps")),
        "https://artifacts.example",
        wallet,
        new PostgresPaymentStore(auth, pool("wallet"), chain),
      );
      const header = async (id = 101, age = 0) => ({
        authorization: `tma ${await signed({ user: JSON.stringify({ id }), auth_date: String(Math.floor(Date.now() / 1000) - age) })}`,
        "content-type": "application/json",
      });
      const request = async (
        method: string,
        path: string,
        body?: unknown,
        id = 101,
        age = 0,
      ) =>
        app.request(path, {
          method,
          headers: await header(id, age),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const expect = async (response: Promise<Response>, status: number) => {
        const result = await response;
        const text = await result.text();
        assert(
          result.status === status,
          `Expected ${status}, got ${result.status}: ${text}`,
        );
        assert(result.headers.get("cache-control") === "no-store");
        return JSON.parse(text);
      };
      const link = async () => {
        const challenge = await expect(
          request("POST", "/me/wallet/challenge"),
          200,
        );
        const proof = walletProof(challenge.payload);
        await expect(request("POST", "/me/wallet/link", proof), 200);
        return proof.address;
      };
      const sender = await link();
      const input = {
        appId,
        idempotencyKey: "fixture_first",
        token: "TON",
        amount: "9007199254740993",
        recipient: `0:${"9".repeat(64)}`,
        sender,
        purpose: "Fixture payment",
      };
      const prepare = (idempotencyKey: string) =>
        request("POST", "/me/payments", { ...input, idempotencyKey });
      await expect(request("POST", "/me/payments", input), 403);
      await expect(
        Promise.resolve(app.request("/me/payments", { method: "POST" })),
        401,
      );
      await expect(
        request("POST", "/me/payments", { ...input, subjectId: "foreign" }),
        400,
      );
      await expect(
        request("POST", "/me/payments", { ...input, amount: "1.5" }),
        400,
      );
      await expect(request("POST", "/me/payments", input, 101, 3700), 401);

      const reviewer = (
        await admin.query("SELECT identity.resolve_telegram(102) AS id")
      ).rows[0].id;
      await admin.query(
        "INSERT INTO identity.role_grants(subject_id,role_name) VALUES($1,'apps.reviewer') ON CONFLICT DO NOTHING",
        [reviewer],
      );
      let version = await expect(
        request("POST", `/apps/${appId}/versions`, {
          manifest: {
            name: "Payment fixture",
            author: "Fixture",
            designRoute: "free-style",
            permissions: ["money.transfer"],
            minPlatformVersion: "1.0.0",
          },
          sha256: "b".repeat(64),
        }),
        201,
      );
      await expect(
        request(
          "POST",
          `/apps/${appId}/versions/${version.versionId}/approve`,
          { reason: "Fixture reviewed" },
          102,
        ),
        200,
      );
      const publish = () =>
        expect(
          request(
            "POST",
            `/apps/${appId}/versions/${version.versionId}/publish`,
            {},
            102,
          ),
          200,
        );
      await publish();
      const first = (await expect(prepare("fixture_first"), 200)).payment;
      assert(
        first.status === "prepared" &&
          first.amount === input.amount &&
          first.feeEstimate.nano === "1234567",
      );
      const repeated = (await expect(prepare("fixture_first"), 200)).payment;
      assert(
        repeated.intentId === first.intentId && Number(chain.signatures) === 0,
      );
      await expect(
        request("POST", "/me/payments", { ...input, amount: "2" }),
        409,
      );
      const path = (intentId: string, action = "", slug = appId) =>
        `/me/payments/${intentId}${action}?appId=${slug}`;
      await expect(
        request("POST", path(first.intentId, "/claim"), undefined, 102),
        403,
      );
      await expect(
        request("GET", path(first.intentId, "", "fixture.other")),
        403,
      );
      await expect(request("GET", path(first.intentId), undefined, 102), 403);
      await expect(
        request("POST", path(first.intentId, "/cancel"), undefined, 102),
        403,
      );
      await expect(
        request("POST", path(first.intentId, "/claim"), undefined, 101, 3700),
        401,
      );
      await expect(
        request("POST", "/me/payments/not-a-uuid/claim?appId=fixture.payments"),
        400,
      );
      const claims = await Promise.all([
        expect(request("POST", path(first.intentId, "/claim")), 200),
        expect(request("POST", path(first.intentId, "/claim")), 200),
      ]);
      assert(
        claims.filter((result) => result.signRequest !== null).length === 1 &&
          Number(chain.signatures) === 1,
      );
      const signing = claims.find((result) => result.signRequest)?.signRequest;
      assert(
        signing.network === "-239" &&
          signing.messages.length === 1 &&
          signing.messages[0].amount === input.amount,
      );
      assert(
        (await expect(request("GET", path(first.intentId)), 200)).payment
          .status === "unknown",
      );
      assert(
        (await expect(request("POST", path(first.intentId, "/cancel")), 200))
          .payment.status === "unknown",
      );
      assert(
        (await expect(request("POST", path(first.intentId, "/claim")), 200))
          .signRequest === null,
      );
      assert(Number(chain.signatures) === 1);
      chain.confirmed = true;
      assert(
        (await expect(request("GET", path(first.intentId)), 200)).payment
          .status === "paid",
      );
      assert(
        (await expect(request("GET", path(first.intentId)), 200)).payment
          .status === "paid",
      );

      const cancelled = (await expect(prepare("fixture_cancel"), 200)).payment;
      assert(
        (
          await expect(
            request("POST", path(cancelled.intentId, "/cancel")),
            200,
          )
        ).payment.status === "cancelled",
      );
      assert(
        (await expect(request("POST", path(cancelled.intentId, "/claim")), 200))
          .signRequest === null,
      );
      assert(Number(chain.signatures) === 1);
      const withdrawn = (await expect(prepare("fixture_withdraw"), 200))
        .payment;
      await expect(
        request(
          "POST",
          `/apps/${appId}/withdraw`,
          { reason: "Fixture withdrawal" },
          102,
        ),
        200,
      );
      await expect(request("POST", path(withdrawn.intentId, "/claim")), 403);
      assert(Number(chain.signatures) === 1);
      version = await expect(
        request("POST", `/apps/${appId}/versions`, {
          manifest: {
            name: "Payment fixture",
            author: "Fixture",
            designRoute: "free-style",
            permissions: ["money.transfer"],
            minPlatformVersion: "1.0.0",
          },
          sha256: "c".repeat(64),
        }),
        201,
      );
      await expect(
        request(
          "POST",
          `/apps/${appId}/versions/${version.versionId}/approve`,
          { reason: "Fixture reviewed again" },
          102,
        ),
        200,
      );
      await publish();
      const revoked = (await expect(prepare("fixture_revoke"), 200)).payment;
      await expect(
        request("POST", "/me/wallet/revoke", { address: sender }),
        200,
      );
      await expect(request("POST", path(revoked.intentId, "/claim")), 403);
      assert(Number(chain.signatures) === 1);
      await link();
      const duplicate = (await expect(prepare("fixture_receipt"), 200)).payment;
      await expect(request("POST", path(duplicate.intentId, "/claim")), 200);
      await expect(request("GET", path(duplicate.intentId)), 503);
      const persisted = await admin.query(
        "SELECT status,receipt_hash FROM wallet.payment_intents WHERE intent_id=$1",
        [duplicate.intentId],
      );
      assert(
        persisted.rows[0].status === "unknown" &&
          persisted.rows[0].receipt_hash === null,
      );
      const receipts = await admin.query(
        "SELECT count(*)::int AS count FROM wallet.payment_intents WHERE receipt_hash=$1",
        ["f".repeat(64)],
      );
      assert(receipts.rows[0].count === 1);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query("DELETE FROM wallet.payment_intents WHERE app_id=$1", [
        appId,
      ]);
      // Registry audit/version rows are intentionally immutable; disposable DB cleanup uses TRUNCATE.
      await admin.query(
        "TRUNCATE apps.audit_events, apps.versions, apps.registry RESTART IDENTITY CASCADE",
      );
      for (const role of roles)
        await admin.query(`DROP ROLE IF EXISTS payments_fixture_${role}`);
      await admin.end();
    }
  },
);
