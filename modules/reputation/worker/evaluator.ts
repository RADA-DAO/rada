import {
  exactObject,
  freezeRules,
  parseClassification,
  propose,
  validEvidence,
  type AttributedEvidence,
  type EvaluationResult,
  type FrozenRules,
} from "./policy.ts";
export type EvaluationBudget = Readonly<{
  maxConcurrent: number;
  maxTokensPerCall: number;
  costUnitsPerCall: number;
  totalCostUnits: number;
  deadlineMs: number;
}>;
/** The concrete provider adapter must enforce token/cost limits before making a billable call. */
export type ClassificationProvider = (
  request: Readonly<{
    content: string;
    ruleKeys: readonly string[];
    maxTokens: number;
    maxCostUnits: number;
    signal: AbortSignal;
  }>,
) => Promise<unknown>;
export class BoundedEvaluator {
  private active = 0;
  private reserved = 0;
  private readonly rules: FrozenRules;
  private readonly budget: EvaluationBudget;
  private readonly provider: ClassificationProvider;
  constructor(
    rules: FrozenRules,
    budget: EvaluationBudget,
    provider: ClassificationProvider,
  ) {
    this.rules = freezeRules(rules);
    if (
      !exactObject(budget, [
        "maxConcurrent",
        "maxTokensPerCall",
        "costUnitsPerCall",
        "totalCostUnits",
        "deadlineMs",
      ])
    )
      throw new Error("invalid_budget");
    for (const [key, value] of Object.entries(budget))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`invalid_budget_${key}`);
    if (
      budget.maxConcurrent > 32 ||
      budget.maxTokensPerCall > 8192 ||
      budget.deadlineMs > 60000 ||
      budget.costUnitsPerCall > budget.totalCostUnits
    )
      throw new Error("invalid_budget");
    this.budget = Object.freeze({ ...budget });
    this.provider = provider;
  }
  counters(): Readonly<{ active: number; reservedCostUnits: number }> {
    return { active: this.active, reservedCostUnits: this.reserved };
  }
  async evaluate(
    evidence: AttributedEvidence,
    signal?: AbortSignal,
  ): Promise<EvaluationResult> {
    if (!this.rules.rules.length)
      return { state: "needs_interpretation", reason: "unconfigured" };
    if (!validEvidence(evidence))
      return { state: "needs_interpretation", reason: "invalid_attribution" };
    if (evidence.contradictions.length || !evidence.completedClaim)
      return {
        state: "needs_interpretation",
        reason: evidence.contradictions.length
          ? "contradictory_facts"
          : "completion_unclear",
      };
    if (signal?.aborted) return { state: "retry", reason: "aborted" };
    if (this.active >= this.budget.maxConcurrent)
      return { state: "retry", reason: "capacity" };
    if (
      this.reserved >
      this.budget.totalCostUnits - this.budget.costUnitsPerCall
    )
      return { state: "retry", reason: "budget" };
    const attributed = Object.freeze({
      ...evidence,
      contradictions: Object.freeze(
        evidence.contradictions.map((fact) => Object.freeze({ ...fact })),
      ),
    });
    this.active++;
    this.reserved += this.budget.costUnitsPerCall;
    const controller = new AbortController();
    let resolveAbort: (value: EvaluationResult) => void = () => {};
    const interrupted = new Promise<EvaluationResult>((resolve) => {
      resolveAbort = resolve;
    });
    const abort = () => {
      controller.abort();
      resolveAbort({ state: "retry", reason: "aborted" });
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
      resolveAbort({ state: "retry", reason: "timeout" });
    }, this.budget.deadlineMs);
    // Keep the slot occupied until a non-cooperative provider actually settles.
    const pending = Promise.resolve()
      .then(() =>
        this.provider({
          content: attributed.content,
          ruleKeys: this.rules.rules.map((rule) => rule.key),
          maxTokens: this.budget.maxTokensPerCall,
          maxCostUnits: this.budget.costUnitsPerCall,
          signal: controller.signal,
        }),
      )
      .then(
        (output): EvaluationResult => {
          this.active--;
          const parsed = parseClassification(output);
          return parsed
            ? propose(this.rules, attributed, parsed)
            : {
                state: "needs_interpretation",
                reason: "invalid_provider_output",
              };
        },
        (error: unknown): EvaluationResult => {
          this.active--;
          return {
            state: "retry",
            reason:
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "provider_limit"
                ? "provider_limit"
                : "provider_error",
          };
        },
      );
    try {
      return await Promise.race([pending, interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  }
}
