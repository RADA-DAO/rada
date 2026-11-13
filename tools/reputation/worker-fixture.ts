import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  JobLane,
  ReputationJob,
  ReportClassification,
} from "../../modules/reputation/index.ts";
import type { createPostgresFixtureRuntime } from "./postgres-fixture.ts";
export type WorkerRuntime = Awaited<
  ReturnType<typeof createPostgresFixtureRuntime>
>;
export function workerHelpers(runtime: WorkerRuntime) {
  const { workerStore, worker } = runtime;
  assert.ok(workerStore && worker);
  const rule = async (
    options: {
      hash?: string;
      key?: string;
      points?: string;
      capUnit?: "occurrence" | "kyiv_day" | "kyiv_week";
      limit?: number;
    } = {},
  ) => {
    const config = {
      rulesHash: options.hash ?? randomUUID(),
      key: options.key ?? `synthetic.${randomUUID()}`,
      points: options.points ?? "0.3125",
      category: "help",
      cap: { unit: options.capUnit ?? "occurrence", limit: options.limit ?? 1 },
      validFrom: "2020-01-01T00:00:00Z",
      validTo: null,
    };
    await runtime.operator.query(
      "SELECT reputation.configure_rule($1::jsonb)",
      [JSON.stringify(config)],
    );
    return config;
  };
  const report = async (actor: string, occurredAt = "2026-10-25T12:00:00Z") => {
    const receipt = await runtime.store.report(actor, {
      requestId: randomUUID(),
      title: "Completed synthetic draft",
      description: "Concrete synthetic result without mandatory attachment",
      occurredAt,
    });
    assert.equal(receipt.item.status, "pending");
    assert.deepEqual(receipt.item.evidence, []);
    return receipt.item;
  };
  const claim = async (
    itemId: string,
    lane: JobLane = "interpretation",
  ): Promise<ReputationJob> => {
    const job = await workerStore.claim([lane], 60);
    assert.ok(job);
    assert.equal(job.itemId, itemId);
    return job;
  };
  const classification = (
    job: ReputationJob,
    config: { rulesHash: string; key: string },
    semanticKey = randomUUID(),
  ): ReportClassification => ({
    rulesHash: config.rulesHash,
    ruleKey: config.key,
    semanticKey,
    sourceId: job.itemId,
  });
  const counts = async (itemId: string) => {
    const result = await runtime.ownerQuery<{
      decisions: string;
      awards: string;
      receipts: string;
    }>(
      "SELECT (SELECT count(*)::text FROM reputation.decisions WHERE item_id=$1::uuid) AS decisions,(SELECT count(*)::text FROM reputation.report_awards WHERE item_id=$1::uuid) AS awards,(SELECT count(*)::text FROM reputation.job_receipts WHERE item_id=$1::uuid) AS receipts",
      [itemId],
    );
    const row = result.rows[0];
    assert.ok(row);
    return row;
  };
  const denied = async (pool: pg.Pool, sql: string, values: unknown[] = []) => {
    await assert.rejects(
      pool.query(sql, values),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "42501",
    );
  };
  const isolate = async () => {
    // Global claims have no actor filter. Quarantine previous synthetic jobs in this disposable DB.
    await runtime.ownerQuery(
      "UPDATE reputation.jobs SET state='blocked',lease_token=NULL,lease_until=NULL,last_error='synthetic_test_isolation' WHERE state IN ('ready','leased')",
    );
  };
  return {
    store: runtime.store,
    workerStore,
    worker,
    rule,
    report,
    claim,
    classification,
    counts,
    denied,
    isolate,
  };
}
