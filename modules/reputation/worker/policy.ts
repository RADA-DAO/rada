import { createHash } from "node:crypto";
import type { Category } from "../contract.ts";

export type Rule = Readonly<{
  key: string;
  points: string;
  category: Category;
  cap: Readonly<{
    unit: "occurrence" | "kyiv_day" | "kyiv_week";
    limit: number;
  }>;
}>;
export type FrozenRules = Readonly<{ hash: string; rules: readonly Rule[] }>;
/** Populated from authenticated persisted attribution, never provider output. */
export type AttributedEvidence = Readonly<{
  subjectId: string;
  sourceId: string;
  occurrenceKey: string;
  kind: "self_report" | "trusted_fact";
  content: string;
  completedClaim: boolean;
  contradictions: readonly Readonly<{ id: string; detail: string }>[];
}>;
export type Classification = {
  classification:
    "concrete_completed" | "needs_interpretation" | "not_completed";
  ruleKey: string | null;
  reason: string;
};
export type DecisionProposal = Readonly<{
  state: "proposed";
  subjectId: string;
  sourceId: string;
  semanticKey: string;
  rulesHash: string;
  ruleKey: string;
  points: string;
  category: Category;
  cap: Rule["cap"];
  reason: string;
}>;
export type EvaluationResult =
  | DecisionProposal
  | { state: "needs_interpretation"; reason: string }
  | { state: "retry"; reason: string };
export function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const canonicalPoints = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length > 24 ||
    !/^(0|[1-9]\d*)(\.\d{0,3}[1-9])?$/.test(value)
  )
    return false;
  const [whole, fractional = ""] = value.split(".");
  return (
    BigInt(whole ?? "0") * 10000n + BigInt(fractional.padEnd(4, "0")) <=
    9223372036854775807n
  );
};
export function freezeRules(value: unknown): FrozenRules {
  if (
    !exactObject(value, ["hash", "rules"]) ||
    !text(value.hash, 256) ||
    !Array.isArray(value.rules) ||
    value.rules.length > 100
  )
    throw new Error("invalid_rules");
  const rules: Rule[] = value.rules.map((candidate: unknown) => {
    if (
      !exactObject(candidate, ["key", "points", "category", "cap"]) ||
      !text(candidate.key, 64) ||
      !/^[a-z0-9_.:-]+$/.test(candidate.key) ||
      !canonicalPoints(candidate.points) ||
      typeof candidate.category !== "string" ||
      !["work", "content", "help", "participation"].includes(
        candidate.category,
      ) ||
      !exactObject(candidate.cap, ["unit", "limit"]) ||
      typeof candidate.cap.unit !== "string" ||
      !["occurrence", "kyiv_day", "kyiv_week"].includes(candidate.cap.unit) ||
      typeof candidate.cap.limit !== "number" ||
      !Number.isSafeInteger(candidate.cap.limit) ||
      candidate.cap.limit < 1 ||
      candidate.cap.limit > 10000
    )
      throw new Error("invalid_rule");
    return Object.freeze({
      key: candidate.key,
      points: candidate.points,
      category: candidate.category as Category,
      cap: Object.freeze({
        unit: candidate.cap.unit as Rule["cap"]["unit"],
        limit: candidate.cap.limit,
      }),
    });
  });
  if (new Set(rules.map((rule) => rule.key)).size !== rules.length)
    throw new Error("duplicate_rule");
  return Object.freeze({ hash: value.hash, rules: Object.freeze(rules) });
}
export function validEvidence(value: unknown): value is AttributedEvidence {
  return (
    exactObject(value, [
      "subjectId",
      "sourceId",
      "occurrenceKey",
      "kind",
      "content",
      "completedClaim",
      "contradictions",
    ]) &&
    text(value.subjectId, 128) &&
    text(value.sourceId, 256) &&
    text(value.occurrenceKey, 256) &&
    typeof value.kind === "string" &&
    ["self_report", "trusted_fact"].includes(value.kind) &&
    text(value.content, 8000) &&
    typeof value.completedClaim === "boolean" &&
    Array.isArray(value.contradictions) &&
    value.contradictions.length <= 10 &&
    value.contradictions.every(
      (fact: unknown) =>
        exactObject(fact, ["id", "detail"]) &&
        text(fact.id, 128) &&
        text(fact.detail, 1000),
    )
  );
}
export function parseClassification(value: unknown): Classification | null {
  if (
    !exactObject(value, ["classification", "ruleKey", "reason"]) ||
    typeof value.classification !== "string" ||
    !["concrete_completed", "needs_interpretation", "not_completed"].includes(
      value.classification,
    ) ||
    !(value.ruleKey === null || text(value.ruleKey, 64)) ||
    !text(value.reason, 1000)
  )
    return null;
  return value as Classification;
}
/** Pure mapping. It proposes a single policy award; the durable commit must enforce caps. */
export function propose(
  rules: FrozenRules,
  evidence: AttributedEvidence,
  classification: Classification,
): EvaluationResult {
  if (!parseClassification(classification))
    return { state: "needs_interpretation", reason: "invalid_provider_output" };
  if (!validEvidence(evidence))
    return { state: "needs_interpretation", reason: "invalid_attribution" };
  if (evidence.contradictions.length)
    return { state: "needs_interpretation", reason: "contradictory_facts" };
  if (
    !evidence.completedClaim ||
    classification.classification !== "concrete_completed"
  )
    return { state: "needs_interpretation", reason: "completion_unclear" };
  const rule = rules.rules.find(
    (candidate) => candidate.key === classification.ruleKey,
  );
  if (!rule) return { state: "needs_interpretation", reason: "unknown_rule" };
  return Object.freeze({
    state: "proposed",
    subjectId: evidence.subjectId,
    sourceId: evidence.sourceId,
    // Reclassification/ruleset updates cannot mint a second award for the same occurrence.
    semanticKey: createHash("sha256")
      .update(
        JSON.stringify([
          evidence.subjectId,
          evidence.kind,
          evidence.occurrenceKey,
        ]),
      )
      .digest("hex"),
    rulesHash: rules.hash,
    ruleKey: rule.key,
    points: rule.points,
    category: rule.category,
    cap: rule.cap,
    reason: classification.reason,
  });
}
