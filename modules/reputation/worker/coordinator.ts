import { createHash } from "node:crypto";
import type {
  PostgresReputationWorkerStore as JobStore,
  ReputationJob,
  JobCommit,
} from "../api/worker-store.ts";
import {
  freezeRules,
  type AttributedEvidence,
  type DecisionProposal,
  type FrozenRules,
} from "./policy.ts";
import type { BoundedEvaluator } from "./evaluator.ts";
import type { membershipVerifier, MembershipResult } from "./membership.ts";
type Store = Pick<JobStore, keyof JobStore>;
type Facts = Pick<
  AttributedEvidence,
  "occurrenceKey" | "completedClaim" | "contradictions"
>;
type Evaluator = Pick<BoundedEvaluator, "evaluate">;
const bounded = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const isAborted = (signal: AbortSignal) => signal.aborted;
export type ExternalVerifier = ReturnType<typeof membershipVerifier>;
export type CoordinatorOutcome = {
  state:
    | "idle"
    | "capacity"
    | "completed"
    | "retry"
    | "blocked"
    | "needs_interpretation"
    | "lease_lost"
    | "unavailable";
  itemId?: string;
  reason?: string;
  result?: JobCommit;
};
export type CoordinatorObservation = {
  lane?: ReputationJob["lane"];
  state: CoordinatorOutcome["state"] | "claimed";
  reason: string;
};
export type CoordinatorOptions = {
  store: Store;
  rulesHash(
    job: Readonly<ReputationJob>,
    signal: AbortSignal,
  ): string | null | Promise<string | null>;
  facts(
    job: Readonly<ReputationJob>,
    signal: AbortSignal,
  ): Facts | Promise<Facts>;
  evaluatorFactory(rules: FrozenRules): Evaluator;
  externalVerifiers: ReadonlyMap<string, ExternalVerifier>;
  deadlineMs: number;
  maxCachedEvaluators?: number;
  maxConcurrent?: number;
  retrySeconds?: number;
  observe?(event: Readonly<CoordinatorObservation>): void;
};
export type BatchLimits = { maxJobs: number; maxDurationMs: number };
type Plan =
  | { type: "report"; proposal: DecisionProposal }
  | {
      type: "external";
      verification: Extract<MembershipResult, { state: "verified" }>;
    }
  | { type: "retry"; reason: string }
  | {
      type: "needs_interpretation";
      reason: string;
      proposal: { state: "needs_interpretation"; reason: string };
    };
function interruptible<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      reject(new Error("interrupted"));
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("preparation_failed"));
      },
    );
  });
}
export class ReputationCoordinator {
  private options: CoordinatorOptions;
  private evaluators = new Map<
    string,
    { fingerprint: string; evaluator: Evaluator }
  >();
  private active = 0;
  private externalActive = 0;
  constructor(options: CoordinatorOptions) {
    if (
      !bounded(options.deadlineMs, 1, 50000) ||
      !bounded(options.maxCachedEvaluators ?? 16, 1, 64) ||
      !bounded(options.maxConcurrent ?? 4, 1, 32) ||
      !bounded(options.retrySeconds ?? 300, 1, 86400)
    )
      throw new Error("invalid_coordinator_limits");
    this.options = {
      ...options,
      externalVerifiers: new Map(options.externalVerifiers),
    };
  }
  private observe(
    state: CoordinatorObservation["state"],
    reason: string,
    job?: ReputationJob,
  ) {
    try {
      this.options.observe?.(
        job ? { state, reason, lane: job.lane } : { state, reason },
      );
    } catch {
      /* Observability cannot alter decisions. */
    }
  }
  private async prepare(
    job: ReputationJob,
    signal: AbortSignal,
  ): Promise<Plan> {
    if (job.lane === "source_fact")
      return { type: "retry", reason: "deterministic_handler_required" };
    if (job.lane === "external") {
      const verifier = job.missionId
        ? this.options.externalVerifiers.get(job.missionId)
        : undefined;
      if (!verifier || !job.telegramUserId || !job.missionId)
        return { type: "retry", reason: "external_unconfigured" };
      if (this.externalActive >= (this.options.maxConcurrent ?? 4))
        return { type: "retry", reason: "external_capacity" };
      this.externalActive++;
      const verification = await Promise.resolve()
        .then(() =>
          verifier(
            {
              subjectId: job.subjectId,
              missionId: job.missionId as string,
              telegramUserId: job.telegramUserId as string,
            },
            signal,
          ),
        )
        .finally(() => {
          this.externalActive--;
        });
      signal.throwIfAborted();
      if (verification.state !== "verified")
        return { type: "retry", reason: "external_checking" };
      const semanticKey = createHash("sha256")
        .update(
          JSON.stringify([job.subjectId, "telegram_membership", job.missionId]),
        )
        .digest("hex");
      if (
        verification.subjectId !== job.subjectId ||
        verification.missionId !== job.missionId ||
        verification.semanticKey !== semanticKey
      )
        return { type: "retry", reason: "external_attribution_mismatch" };
      return { type: "external", verification };
    }
    const hash = await this.options.rulesHash(job, signal);
    signal.throwIfAborted();
    if (!hash) return { type: "retry", reason: "rules_unconfigured" };
    const snapshot = await this.options.store.rules(
      job.itemId,
      job.leaseToken,
      hash,
    );
    signal.throwIfAborted();
    if (!snapshot) return { type: "retry", reason: "rules_unconfigured" };
    const rules = freezeRules(snapshot);
    if (rules.hash !== hash)
      return { type: "retry", reason: "policy_snapshot_mismatch" };
    const fingerprint = JSON.stringify(rules);
    let cached = this.evaluators.get(hash);
    if (cached && cached.fingerprint !== fingerprint)
      return { type: "retry", reason: "policy_snapshot_mismatch" };
    if (!cached) {
      if (this.evaluators.size >= (this.options.maxCachedEvaluators ?? 16))
        return { type: "retry", reason: "policy_capacity" };
      cached = { fingerprint, evaluator: this.options.evaluatorFactory(rules) };
      this.evaluators.set(hash, cached);
    }
    const facts = await this.options.facts(job, signal);
    signal.throwIfAborted();
    const evidence: AttributedEvidence = {
      subjectId: job.subjectId,
      sourceId: job.sourceId,
      kind: "self_report",
      content: job.description,
      occurrenceKey: facts.occurrenceKey,
      completedClaim: facts.completedClaim,
      contradictions: facts.contradictions,
    };
    const proposal = await cached.evaluator.evaluate(evidence, signal);
    signal.throwIfAborted();
    if (proposal.state === "retry")
      return { type: "retry", reason: "interpretation_retry" };
    if (proposal.state === "needs_interpretation")
      return {
        type: "needs_interpretation",
        reason: "interpretation_unclear",
        proposal,
      };
    if (
      proposal.subjectId !== job.subjectId ||
      proposal.sourceId !== job.sourceId ||
      proposal.rulesHash !== hash ||
      proposal.semanticKey !==
        createHash("sha256")
          .update(
            JSON.stringify([job.subjectId, "self_report", facts.occurrenceKey]),
          )
          .digest("hex") ||
      !rules.rules.some((rule) => rule.key === proposal.ruleKey)
    )
      return { type: "retry", reason: "proposal_attribution_mismatch" };
    return { type: "report", proposal };
  }
  private async retry(
    job: ReputationJob,
    plan: Extract<Plan, { type: "retry" | "needs_interpretation" }>,
  ): Promise<CoordinatorOutcome> {
    if (plan.type === "needs_interpretation")
      await this.options.store.saveProposal(job.itemId, job.leaseToken, {
        ...plan.proposal,
      });
    const result = await this.options.store.retry(
      job.itemId,
      job.leaseToken,
      this.options.retrySeconds ?? 300,
      plan.reason,
    );
    const state = result.state === "blocked" ? "blocked" : plan.type;
    this.observe(state, plan.reason, job);
    return { state, itemId: job.itemId, reason: plan.reason, result };
  }
  async runNext(signal?: AbortSignal): Promise<CoordinatorOutcome> {
    if (signal?.aborted) return { state: "retry", reason: "aborted" };
    if (this.active >= (this.options.maxConcurrent ?? 4))
      return { state: "capacity", reason: "worker_capacity" };
    this.active++;
    let job: ReputationJob | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      job = await this.options.store.claim(["interpretation", "external"], 60);
      if (!job) {
        this.observe("idle", "queue_empty");
        return { state: "idle" };
      }
      this.observe("claimed", "claimed", job);
      const remaining = Math.min(
        this.options.deadlineMs,
        Date.parse(job.leaseUntil) - Date.now() - 1000,
      );
      if (signal?.aborted || !Number.isFinite(remaining) || remaining <= 0)
        controller.abort();
      else timer = setTimeout(abort, remaining);
      let plan: Plan;
      try {
        plan = await interruptible(
          this.prepare(job, controller.signal),
          controller.signal,
        );
      } catch {
        plan = {
          type: "retry",
          reason: controller.signal.aborted
            ? signal?.aborted
              ? "aborted"
              : "deadline"
            : "technical_failure",
        };
      }
      if (plan.type === "retry" || plan.type === "needs_interpretation")
        return await this.retry(job, plan);
      if (isAborted(controller.signal))
        return await this.retry(job, { type: "retry", reason: "deadline" });
      let result: JobCommit;
      if (plan.type === "report") {
        await this.options.store.saveProposal(job.itemId, job.leaseToken, {
          ...plan.proposal,
        });
        if (isAborted(controller.signal))
          return await this.retry(job, { type: "retry", reason: "deadline" });
        const { rulesHash, ruleKey, semanticKey, sourceId } = plan.proposal;
        result = await this.options.store.commitReport(
          job.itemId,
          job.leaseToken,
          { rulesHash, ruleKey, semanticKey, sourceId },
        );
      } else {
        const proof = plan.verification;
        result = await this.options.store.finalizeExternal(
          job.itemId,
          job.leaseToken,
          {
            source: "telegram-membership",
            sourceId: proof.semanticKey,
            evidenceUrl: proof.proofUrl,
          },
        );
      }
      const state =
        result.state === "completed"
          ? "completed"
          : result.state === "blocked"
            ? "blocked"
            : "retry";
      this.observe(state, "database_result", job);
      return { state, itemId: job.itemId, result };
    } catch (error) {
      const conflict =
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505";
      const state = conflict ? "lease_lost" : "unavailable";
      this.observe(
        state,
        conflict ? "lease_or_commit_conflict" : "storage_unavailable",
        job ?? undefined,
      );
      return {
        state,
        ...(job ? { itemId: job.itemId } : {}),
        reason: "storage_unavailable",
      };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener("abort", abort);
      this.active--;
    }
  }
  async runBoundedBatch(
    limits: BatchLimits,
    signal?: AbortSignal,
  ): Promise<CoordinatorOutcome[]> {
    if (
      !bounded(limits.maxJobs, 1, 100) ||
      !bounded(limits.maxDurationMs, 1, 600000)
    )
      throw new Error("invalid_batch_limits");
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, limits.maxDurationMs);
    const outcomes: CoordinatorOutcome[] = [];
    try {
      while (outcomes.length < limits.maxJobs && !controller.signal.aborted) {
        const outcome = await this.runNext(controller.signal);
        outcomes.push(outcome);
        if (
          outcome.state === "idle" ||
          outcome.state === "capacity" ||
          outcome.state === "unavailable"
        )
          break;
      }
      return outcomes;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
export const runNext = (
  coordinator: ReputationCoordinator,
  signal?: AbortSignal,
) => coordinator.runNext(signal);
export const runBoundedBatch = (
  coordinator: ReputationCoordinator,
  limits: BatchLimits,
  signal?: AbortSignal,
) => coordinator.runBoundedBatch(limits, signal);
