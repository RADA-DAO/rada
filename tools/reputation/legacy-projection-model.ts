import { createHash } from "node:crypto";
import type { Category } from "../../modules/reputation/index.ts";
import type { ShadowSnapshot } from "../reputation-shadow.ts";
export type LegacyItem = {
  key: string;
  title: string;
  category: string;
  points: string;
  evidence: string[];
};
export type LegacyPending = { title: string; evidence: string[] };
export type LegacyMember = {
  userId: number;
  label: string;
  points: string;
  items: LegacyItem[];
  pending: LegacyPending[];
};
export type LegacyProjection = {
  schemaVersion: number;
  status: "preliminary" | "reviewed";
  weekStart: string;
  assessedThrough: string;
  ruleVersion: string;
  rulesHash: string;
  assessmentHash: string;
  members: LegacyMember[];
  fullReviewHash?: string;
  fullReviewThrough?: string;
  coverageWarnings?: unknown[];
  sourceDispositions?: Record<
    string,
    { status: string; reason: string; reviewedAt: string }
  >;
};
export type RowContext = {
  userId: number;
  kind: "accepted" | "pending" | "excluded" | "superseded";
  sourceKey: string;
  sourceCategory: string | null;
  evidence: readonly string[];
};
export type RowResolution = {
  identityKey: string;
  sourceCategory: string;
  occurredAt: string;
};
export type LegacyInput = {
  projection: LegacyProjection;
  roster: readonly number[];
  cutoff: string;
  /** Exact reporting.encode bytes, not JSON.stringify of parsed Python floats. */
  frozenRulesJson: string;
  frozenRulesHash: string;
  categoryMap: Readonly<Record<string, Category>>;
  opaque(
    scope: "subject" | "row" | "evidence" | "reason",
    value: string,
  ): string;
  expectedAssessmentHash?: string;
  expectedFullReviewHash?: string;
};
export type StrictInput = LegacyInput & {
  resolveRow(context: RowContext): RowResolution | null;
  dispositionOwners(url: string): readonly number[] | null;
  lifetimePoints(userId: number): string | null;
};
export type ShadowRow = ShadowSnapshot["rows"][number];
export type WeekRow = Omit<
  ShadowRow,
  "category" | "occurredAt" | "ruleHash" | "exclusionReason"
> & { category: Category | null; sourceCategoryKey: string | null };
export type SourceExclusion = {
  key: string;
  evidenceKey: string;
  status: "excluded" | "superseded";
  reasonKey: string;
  reviewedAt: string;
};
export const categories: Category[] = [
  "content",
  "help",
  "participation",
  "work",
];
export class Invalid extends Error {}
export function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Invalid(code);
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Fraction strings are reduced exactly; no floating point or rounding. */
export function exactPoints(value: string): { units: bigint; decimal: string } {
  requireValue(
    typeof value === "string" &&
      value.length <= 80 &&
      /^\d+(?:\.\d+|\/\d+)?$/.test(value),
    "invalid_points",
  );
  const [whole = "0", part] = value.split(/[./]/);
  const numerator = value.includes(".")
    ? BigInt(whole + (part ?? ""))
    : BigInt(whole);
  const denominator = value.includes("/")
    ? BigInt(part ?? "0")
    : value.includes(".")
      ? 10n ** BigInt(part?.length ?? 0)
      : 1n;
  requireValue(
    denominator > 0n && (numerator * 10000n) % denominator === 0n,
    "unrepresentable_points",
  );
  const units = (numerator * 10000n) / denominator;
  requireValue(units <= 9223372036854775807n, "points_out_of_range");
  const fraction = (units % 10000n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return {
    units,
    decimal: `${String(units / 10000n)}${fraction ? `.${fraction}` : ""}`,
  };
}
export function instant(value: string): bigint {
  const match =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(
      value,
    );
  requireValue(match, "invalid_timestamp");
  const base = match[1] ?? "";
  requireValue(
    Number.isFinite(Date.parse(value)) &&
      new Date(`${base}Z`).toISOString().slice(0, 19) === base,
    "invalid_timestamp",
  );
  return (
    BigInt(Date.parse(`${base}${match[3] ?? "Z"}`)) * 1000000n +
    BigInt((match[2] ?? "").padEnd(9, "0"))
  );
}
/** Compare Kyiv calendar dates so the DST week may contain 167 or 169 hours. */
function validateWeek(start: string, cutoff: string) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = (value: string) => formatter.formatToParts(new Date(value));
  const part = (
    values: Intl.DateTimeFormatPart[],
    name: Intl.DateTimeFormatPartTypes,
  ) => values.find((value) => value.type === name)?.value;
  const first = parts(start);
  requireValue(
    part(first, "weekday") === "Mon" &&
      ["hour", "minute", "second"].every(
        (name) => part(first, name as Intl.DateTimeFormatPartTypes) === "00",
      ) &&
      instant(start) % 1000000000n === 0n,
    "invalid_kyiv_week_start",
  );
  const day = (values: Intl.DateTimeFormatPart[]) =>
    Date.UTC(
      Number(part(values, "year")),
      Number(part(values, "month")) - 1,
      Number(part(values, "day")),
    );
  const elapsedDays = (day(parts(cutoff)) - day(first)) / 86400000;
  requireValue(elapsedDays >= 0 && elapsedDays < 7, "cutoff_outside_kyiv_week");
}
export function token(
  input: LegacyInput,
  scope: Parameters<LegacyInput["opaque"]>[0],
  value: string,
) {
  const result = input.opaque(scope, value);
  requireValue(/^[a-f0-9]{64}$/.test(result), "invalid_opaque_identity");
  return result;
}
export function mapped(input: LegacyInput, source: string): Category {
  const result = Object.hasOwn(input.categoryMap, source)
    ? input.categoryMap[source]
    : undefined;
  requireValue(result && categories.includes(result), "unknown_category");
  return result;
}
export function evidence(input: LegacyInput, urls: readonly string[]) {
  requireValue(
    Array.isArray(urls) &&
      urls.length > 0 &&
      urls.every((url) => typeof url === "string" && url.length > 0) &&
      new Set(urls).size === urls.length,
    "invalid_or_duplicate_evidence",
  );
  const keys = urls
    .map((url: unknown) => {
      requireValue(typeof url === "string", "invalid_evidence");
      return token(input, "evidence", url);
    })
    .sort();
  requireValue(
    new Set(keys).size === keys.length,
    "evidence_identity_collision",
  );
  return keys;
}
export function context(
  userId: number,
  kind: "accepted" | "pending",
  row: LegacyItem | LegacyPending,
): RowContext {
  return {
    userId,
    kind,
    sourceKey:
      "key" in row ? row.key : JSON.stringify([...row.evidence].sort()),
    sourceCategory: "category" in row ? row.category : null,
    evidence: row.evidence,
  };
}
export function rowKey(
  input: LegacyInput,
  row: RowContext,
  identity = row.sourceKey,
  sourceCategory = row.sourceCategory,
) {
  return token(
    input,
    "row",
    JSON.stringify([
      row.userId,
      row.kind,
      sourceCategory,
      row.sourceKey,
      identity,
    ]),
  );
}
export function prepare(input: LegacyInput) {
  const p = input.projection;
  requireValue(
    p.schemaVersion === 1 &&
      ["preliminary", "reviewed"].includes(p.status) &&
      Array.isArray(p.members),
    "invalid_projection",
  );
  requireValue(
    input.cutoff === p.assessedThrough &&
      instant(input.cutoff) >= instant(p.weekStart),
    "cutoff_mismatch",
  );
  validateWeek(p.weekStart, input.cutoff);
  requireValue(
    /^[a-f0-9]{64}$/.test(p.assessmentHash) &&
      (!input.expectedAssessmentHash ||
        p.assessmentHash === input.expectedAssessmentHash),
    "assessment_hash_mismatch",
  );
  const rules: unknown = JSON.parse(input.frozenRulesJson);
  requireValue(
    rules &&
      typeof rules === "object" &&
      "version" in rules &&
      rules.version === p.ruleVersion &&
      digest(input.frozenRulesJson) === input.frozenRulesHash &&
      p.rulesHash === input.frozenRulesHash,
    "rules_hash_mismatch",
  );
  requireValue(
    !input.expectedFullReviewHash ||
      p.fullReviewHash === input.expectedFullReviewHash,
    "full_review_hash_mismatch",
  );
  requireValue(
    input.roster.length > 0 &&
      new Set(input.roster).size === input.roster.length &&
      input.roster.every((id) => Number.isSafeInteger(id) && id > 0),
    "invalid_roster",
  );
  requireValue(
    p.members.length === input.roster.length &&
      new Set(p.members.map((member) => member.userId)).size ===
        p.members.length &&
      p.members.every((member) => input.roster.includes(member.userId)),
    "missing_or_duplicate_member",
  );
  const roster = input.roster.map((id) => token(input, "subject", String(id)));
  requireValue(
    new Set(roster).size === roster.length,
    "subject_identity_collision",
  );
  requireValue(
    !p.fullReviewHash ||
      (p.sourceDispositions &&
        p.fullReviewThrough &&
        instant(p.fullReviewThrough) <= instant(input.cutoff) &&
        /^[a-f0-9]{64}$/.test(p.fullReviewHash)),
    "missing_full_review_dispositions",
  );
  const allEvidence = new Set(
    p.members
      .flatMap((member) =>
        [...member.items, ...member.pending].flatMap((row) => row.evidence),
      )
      .concat(Object.keys(p.sourceDispositions ?? {})),
  );
  requireValue(
    new Set([...allEvidence].map((url) => token(input, "evidence", url)))
      .size === allEvidence.size,
    "evidence_identity_collision",
  );
  const sourceManifest: SourceExclusion[] = [];
  for (const [url, disposition] of Object.entries(p.sourceDispositions ?? {})) {
    requireValue(
      [
        "included",
        "publication_only",
        "pending_event",
        "merged",
        "excluded",
      ].includes(disposition.status),
      "unknown_disposition",
    );
    if (!["excluded", "merged"].includes(disposition.status)) continue;
    requireValue(
      disposition.reason &&
        instant(disposition.reviewedAt) <= instant(input.cutoff),
      "invalid_exclusion",
    );
    sourceManifest.push({
      key: token(
        input,
        "row",
        JSON.stringify(["source-disposition", url, disposition.status]),
      ),
      evidenceKey: token(input, "evidence", url),
      status: disposition.status === "merged" ? "superseded" : "excluded",
      reasonKey: token(input, "reason", disposition.reason),
      reviewedAt: disposition.reviewedAt,
    });
  }
  requireValue(
    new Set(sourceManifest.map((row) => row.key)).size ===
      sourceManifest.length,
    "source_identity_collision",
  );
  return {
    roster,
    sourceManifest,
    origin: {
      kind: "legacy-projection-adapter" as const,
      independentCandidate: false as const,
      independentScoring: false as const,
      assessmentHash: p.assessmentHash,
      fullReviewHash: p.fullReviewHash ?? null,
      coverageWarningsCount: p.coverageWarnings?.length ?? 0,
    },
  };
}
