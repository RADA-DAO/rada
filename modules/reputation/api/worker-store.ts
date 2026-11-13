import type pg from "pg";
import type { Category, Evidence, ReputationItem } from "../contract.ts";
export type JobLane = "interpretation" | "external";
/** Private attributed worker input; never pass subjectId to a provider. */
export type ReputationJob = {
  itemId: string;
  missionId: string | null;
  telegramUserId?: string | null;
  subjectId: string;
  sourceId: string;
  lane: JobLane;
  leaseToken: string;
  leaseUntil: string;
  attempt: number;
  title: string;
  description: string;
  occurredAt: string;
  evidence: Evidence[];
};
export type FrozenRule = {
  key: string;
  points: string;
  category: Category;
  cap: { unit: "occurrence" | "kyiv_day" | "kyiv_week"; limit: number };
};
export type FrozenRuleSnapshot = { hash: string; rules: FrozenRule[] };
export type JobRetry = {
  state: "ready" | "blocked";
  retryAt: string;
  attempt: number;
  reason: string;
};
export type JobCommit = { state: "completed"; item: ReputationItem } | JobRetry;
export type ReportClassification = {
  rulesHash: string;
  ruleKey: string;
  semanticKey: string;
  sourceId: string;
};

/** The worker pool inherits reputation_worker only, with no HTTP/table grants. */
export class PostgresReputationWorkerStore {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  private async call<T>(sql: string, values: unknown[]): Promise<T> {
    // Each SQL function is one atomic database transaction. No model/network work
    // runs while a transaction or connection is retained by this adapter.
    const result = await this.pool.query<{ result: T }>(sql, values);
    return result.rows[0]!.result;
  }
  claim(
    lanes: JobLane[] = ["interpretation", "external"],
    leaseSeconds = 60,
  ): Promise<ReputationJob | null> {
    return this.call("SELECT reputation.claim_job($1::text[],$2) AS result", [
      lanes,
      leaseSeconds,
    ]);
  }
  rules(
    itemId: string,
    leaseToken: string,
    rulesHash: string,
  ): Promise<FrozenRuleSnapshot | null> {
    return this.call(
      "SELECT reputation.job_rules($1::uuid,$2::uuid,$3) AS result",
      [itemId, leaseToken, rulesHash],
    );
  }
  saveProposal(
    itemId: string,
    leaseToken: string,
    proposal: Record<string, unknown>,
  ): Promise<string> {
    return this.call(
      "SELECT reputation.save_proposal($1::uuid,$2::uuid,$3::jsonb) AS result",
      [itemId, leaseToken, JSON.stringify(proposal)],
    );
  }
  retry(
    itemId: string,
    leaseToken: string,
    retrySeconds: number,
    reason: string,
  ): Promise<JobRetry> {
    return this.call(
      "SELECT reputation.retry_job($1::uuid,$2::uuid,$3,$4) AS result",
      [itemId, leaseToken, retrySeconds, reason],
    );
  }
  commitReport(
    itemId: string,
    leaseToken: string,
    proposal: ReportClassification,
  ): Promise<JobCommit> {
    return this.call(
      "SELECT reputation.complete_report($1::uuid,$2::uuid,$3,$4,$5,$6) AS result",
      [
        itemId,
        leaseToken,
        proposal.rulesHash,
        proposal.ruleKey,
        proposal.semanticKey,
        proposal.sourceId,
      ],
    );
  }
  finalizeExternal(
    itemId: string,
    leaseToken: string,
    input: { source: string; sourceId: string; evidenceUrl: string },
  ): Promise<JobCommit> {
    return this.call(
      "SELECT reputation.complete_external($1::uuid,$2::uuid,$3,$4,$5) AS result",
      [itemId, leaseToken, input.source, input.sourceId, input.evidenceUrl],
    );
  }
}
