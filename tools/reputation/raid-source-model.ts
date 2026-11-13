import { createHash } from "node:crypto";
import type { Category } from "../../modules/reputation/index.ts";
export type RaidPost = {
  url: string;
  author: number | null;
  album?: string | number | null;
};
export type RaidComment = {
  id: string | number;
  authorId: number;
  eventAt: string;
  url: string;
  postUrl: string;
  text: string;
  bot?: boolean;
  deleted?: boolean;
  forwarded?: boolean;
};
export type AcceptedEventEntry = {
  actorId: number;
  status: "accepted";
  scope: "current" | "prior";
  key: string;
  category: string;
  evidence: readonly string[];
};
export type RaidSourceInput = {
  weekStart: string;
  cutoff: string;
  frozenRulesJson: string;
  frozenRulesHash: string;
  roster: readonly number[];
  excludedActorIds: readonly number[];
  posts: readonly RaidPost[];
  comments: readonly RaidComment[];
  acceptedEventEntries: readonly AcceptedEventEntry[];
  sourceDispositions?: Readonly<Record<string, unknown>>;
  excludedComments?: readonly string[];
};
export type RaidFact = {
  actorId: number;
  key: string;
  sourceId: string;
  semanticKey: string;
  rulesHash: string;
  ruleKey: "participation.distinctRaidPost";
  points: string;
  category: Category;
  sourceCategory: "raid";
  occurredAt: string;
  evidence: string[];
  anchorEvidenceUrl: string;
  rawCommentCount: number;
};
export type RaidFinding = { commentId: string | null; reason: string };
export type RaidSourceResult = {
  version: 1;
  weekStart: string;
  cutoff: string;
  rulesHash: string;
  roster: number[];
  facts: RaidFact[];
  blocked: RaidFinding[];
  excluded: RaidFinding[];
  reviewedDispositions: {
    sourceDispositions: Readonly<Record<string, unknown>>;
    excludedComments: readonly string[];
    effectOnRaid: "audit_only_under_observed_units_v1";
  };
  scope: {
    kind: "raw_dated_raid_subset";
    independentCandidate: true;
    independentScoring: true;
    complete: boolean;
    excludedLanes: string[];
  };
};
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
export const actor = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
/** Nanosecond comparisons retain source fractions; dates are never synthesized. */
export function instant(value: string): bigint {
  const m =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(
      value,
    );
  requireValue(m, "invalid_event_time");
  const base = m[1] ?? "";
  requireValue(
    Number.isFinite(Date.parse(value)) &&
      new Date(`${base}Z`).toISOString().slice(0, 19) === base,
    "invalid_event_time",
  );
  return (
    BigInt(Date.parse(`${base}${m[3] ?? "Z"}`)) * 1000000n +
    BigInt((m[2] ?? "").padEnd(9, "0"))
  );
}
export function validatePeriod(start: string, cutoff: string) {
  const first = instant(start);
  const last = instant(cutoff);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const get = (date: string, name: Intl.DateTimeFormatPartTypes) =>
    fmt.formatToParts(new Date(date)).find((p) => p.type === name)?.value;
  requireValue(
    get(start, "weekday") === "Mon" &&
      ["hour", "minute", "second"].every(
        (k) => get(start, k as Intl.DateTimeFormatPartTypes) === "00",
      ) &&
      first % 1000000000n === 0n,
    "invalid_kyiv_week_start",
  );
  const day = (date: string) =>
    Date.UTC(
      Number(get(date, "year")),
      Number(get(date, "month")) - 1,
      Number(get(date, "day")),
    );
  requireValue(
    last >= first && day(cutoff) - day(start) < 7 * 86400000,
    "cutoff_outside_week",
  );
}
/** Exact decimal/fraction arithmetic; a JSON number is not an exact source string. */
export function exact(value: unknown): { units: bigint; decimal: string } {
  requireValue(
    typeof value === "string" &&
      value.length <= 80 &&
      /^(?:\d+(?:\.\d+|\/\d+)?|\.\d+)$/.test(value),
    "invalid_exact_rule_weight",
  );
  const v = value.startsWith(".") ? `0${value}` : value;
  const [whole = "0", part = ""] = v.split(/[./]/);
  const numerator = BigInt(v.includes(".") ? whole + part : whole);
  const denominator = v.includes("/")
    ? BigInt(part)
    : v.includes(".")
      ? 10n ** BigInt(part.length)
      : 1n;
  requireValue(
    denominator > 0n && (numerator * 10000n) % denominator === 0n,
    "unrepresentable_rule_weight",
  );
  const units = (numerator * 10000n) / denominator;
  requireValue(units <= 9223372036854775807n, "rule_weight_overflow");
  const fraction = (units % 10000n)
    .toString()
    .padStart(4, "0")
    .replace(/0+$/, "");
  return {
    units,
    decimal: `${String(units / 10000n)}${fraction ? `.${fraction}` : ""}`,
  };
}
export function rule(input: RaidSourceInput): string {
  requireValue(
    typeof input.frozenRulesJson === "string" &&
      input.frozenRulesJson.length <= 1048576 &&
      /^[a-f0-9]{64}$/.test(input.frozenRulesHash) &&
      hash(input.frozenRulesJson) === input.frozenRulesHash,
    "frozen_rules_hash_mismatch",
  );
  const value: unknown = JSON.parse(input.frozenRulesJson);
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "missing_policy",
  );
  const r = value as Record<string, unknown>;
  const p = r.participation;
  requireValue(
    r.activityAccounting === "observed-units-v1" &&
      p &&
      typeof p === "object" &&
      !Array.isArray(p),
    "unsupported_policy",
  );
  const weight = exact((p as Record<string, unknown>).distinctRaidPost);
  requireValue(weight.units > 0n, "nonpositive_rule_weight");
  return weight.decimal;
}
export function unit(post: RaidPost): string {
  const album = post.album;
  if (
    album === null ||
    album === undefined ||
    album === "" ||
    album === 0 ||
    album === "0"
  )
    return post.url;
  requireValue(
    typeof album === "string" || Number.isSafeInteger(album),
    "unsafe_album_identity",
  );
  const value = String(album);
  requireValue(/^-?[1-9]\d{0,19}$/.test(value), "invalid_album_identity");
  return `album:${value}`;
}
