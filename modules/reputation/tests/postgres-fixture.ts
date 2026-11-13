import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import type { ReputationStore, Mission } from "../contract.ts";
import type { CalendarFixture } from "./calendar-contract.ts";

/** Isolated, synthetic test runtime shared by correctness and load drivers. */
export async function createPostgresFixtureRuntime(
  databaseUrl: string,
  maxConnections = 12,
) {
  // This runner connects only to a caller-created disposable loopback database.
  const adminUrl = new URL(databaseUrl);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname));
  assert.match(adminUrl.pathname, /^\/reputation_test_[a-z0-9_]+$/);
  const admin = new pg.Pool({ connectionString: adminUrl.href, max: 4 });
  const suffix = randomBytes(6).toString("hex");
  const createdRoles: string[] = [];
  const pools: pg.Pool[] = [];
  async function login(capability: string): Promise<pg.Pool> {
    assert.match(
      capability,
      /^(identity_auth|reputation_service|reputation_operator|reputation_ingress)$/,
    );
    const name = `rep_test_${suffix}_${capability}`;
    const password = randomBytes(24).toString("hex");
    await admin.query(
      `CREATE ROLE "${name}" LOGIN PASSWORD '${password}' INHERIT`,
    );
    createdRoles.push(name);
    await admin.query(`GRANT ${capability} TO "${name}"`);
    const url = new URL(adminUrl);
    url.username = name;
    url.password = password;
    // Separate physical connections are required to exercise PostgreSQL row locks.
    const pool = new pg.Pool({
      connectionString: url.href,
      max: maxConnections,
      options: "-c statement_timeout=5000",
    });
    pools.push(pool);
    return pool;
  }
  const close = async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    for (const name of [...createdRoles].reverse())
      await admin.query(`DROP ROLE "${name}"`);
    await admin.end();
  };
  try {
    const auth = await login("identity_auth");
    const service = await login("reputation_service");
    const operator = await login("reputation_operator");
    const ingress = await login("reputation_ingress");
    const storePath =
      process.env.REPUTATION_STORE_PATH ??
      fileURLToPath(new URL("../api/store.ts", import.meta.url));
    const { PostgresReputationStore } = (await import(
      pathToFileURL(storePath).href
    )) as {
      PostgresReputationStore: new (
        auth: pg.Pool,
        service: pg.Pool,
      ) => ReputationStore;
    };
    const store = new PostgresReputationStore(auth, service);
    async function ownerQuery<T extends pg.QueryResultRow>(
      sql: string,
      values: unknown[] = [],
    ): Promise<pg.QueryResult<T>> {
      const client = await admin.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE reputation_owner");
        const result = await client.query<T>(sql, values);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    async function subject(actor: string): Promise<string> {
      const result = await auth.query<{ id: string }>(
        "SELECT identity.resolve_telegram($1::bigint) AS id",
        [actor],
      );
      const row = result.rows[0];
      assert.ok(row);
      return row.id;
    }
    async function fixture(): Promise<CalendarFixture> {
      const actor = String(
        8000000000000n + BigInt(`0x${randomBytes(5).toString("hex")}`),
      );
      const otherActor = String(BigInt(actor) + 1n);
      await subject(actor);
      await subject(otherActor);
      return {
        store,
        actor,
        otherActor,
        seedMission: async ({ points, verifier }) => {
          const id = randomUUID();
          await operator.query(
            "SELECT reputation.configure_mission($1::uuid,1,$2,$3,'participation',$4,'synthetic-rule-v1',$5,NULL,true)",
            [
              id,
              "Synthetic acknowledgement",
              "Synthetic fixture only",
              points,
              verifier,
            ],
          );
          return {
            id,
            version: 1,
            title: "Synthetic acknowledgement",
            description: "Synthetic fixture only",
            category: "participation",
            points,
            ruleHash: "synthetic-rule-v1",
            verifier,
            status: "available",
            actionUrl: null,
          } satisfies Mission;
        },
        bounds: async (period, reference) => {
          const result = await ownerQuery<{
            start_at: Date | null;
            end_at: Date;
          }>("SELECT * FROM reputation.bounds($1,$2::timestamptz)", [
            period,
            reference,
          ]);
          const row = result.rows[0];
          assert.ok(row);
          return {
            start: row.start_at?.toISOString() ?? null,
            end: row.end_at.toISOString(),
          };
        },
        seedAccepted: async (actor, occurredAt, points) => {
          const id = await subject(actor);
          const result = await ownerQuery<{ id: string }>(
            "INSERT INTO reputation.items(subject_id,title,description,category,units,status,reason,occurred_at) VALUES($1::uuid,'Synthetic boundary','Fixture only','help',($2::numeric*10000)::bigint,'accepted','synthetic_boundary',$3::timestamptz) RETURNING id",
            [id, points, occurredAt],
          );
          const row = result.rows[0];
          assert.ok(row);
          return row.id;
        },
        close: async () => {
          /* The caller destroys the disposable database after this process exits. */
        },
      };
    }
    return {
      admin,
      auth,
      service,
      operator,
      ingress,
      store,
      fixture,
      subject,
      ownerQuery,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
