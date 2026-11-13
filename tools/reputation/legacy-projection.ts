import type { Category } from "../../modules/reputation/index.ts";
import {
  compareShadowRoster,
  type RosterShadow,
  type ShadowSnapshot,
} from "../reputation-shadow.ts";
import {
  categories,
  context,
  evidence,
  exactPoints,
  instant,
  Invalid,
  mapped,
  prepare,
  requireValue,
  rowKey,
  token,
  type LegacyInput,
  type StrictInput,
  type WeekRow,
  type ShadowRow,
  type RowContext,
} from "./legacy-projection-model.ts";
export { exactPoints } from "./legacy-projection-model.ts";
export type {
  LegacyInput,
  LegacyProjection,
  LegacyMember,
  LegacyItem,
  LegacyPending,
  StrictInput,
  RowContext,
  RowResolution,
} from "./legacy-projection-model.ts";
/** Week-only leaf/aggregate parity; never claims event timing or lifetime parity. */
export function compareLegacyWeek(input: LegacyInput) {
  try {
    const prepared = prepare(input);
    const members = input.projection.members.map((member) => {
      requireValue(
        Array.isArray(member.items) && Array.isArray(member.pending),
        "invalid_member_rows",
      );
      const totals = new Map<Category, bigint>(
        categories.map((category) => [category, 0n]),
      );
      const rows: WeekRow[] = [];
      const seen = new Set<string>();
      for (const [kind, values] of [
        ["accepted", member.items],
        ["pending", member.pending],
      ] as const)
        for (const value of values) {
          const raw = context(member.userId, kind, value);
          requireValue(
            raw.sourceKey && !seen.has(`${kind}:${raw.sourceKey}`),
            "duplicate_row",
          );
          seen.add(`${kind}:${raw.sourceKey}`);
          const category =
            raw.sourceCategory === null
              ? null
              : mapped(input, raw.sourceCategory);
          const points =
            "points" in value ? exactPoints(value.points) : exactPoints("0");
          requireValue(
            kind !== "accepted" || points.units > 0n,
            "invalid_accepted_zero",
          );
          if (category)
            totals.set(category, (totals.get(category) ?? 0n) + points.units);
          rows.push({
            key: rowKey(input, raw),
            sourceCategoryKey:
              raw.sourceCategory === null
                ? null
                : token(input, "row", `source-category:${raw.sourceCategory}`),
            category,
            evidenceKeys: evidence(input, value.evidence),
            points: points.decimal,
            status: kind,
          });
        }
      requireValue(
        new Set(rows.map((row) => row.key)).size === rows.length,
        "row_identity_collision",
      );
      const units = [...totals.values()].reduce(
        (sum, value) => sum + value,
        0n,
      );
      requireValue(
        units === exactPoints(member.points).units,
        "reported_total_mismatch",
      );
      return {
        subjectAlias: token(input, "subject", String(member.userId)),
        totalPoints: exactPoints(`${String(units)}/10000`).decimal,
        categories: categories.map((category) => ({
          category,
          points: exactPoints(`${String(totals.get(category) ?? 0n)}/10000`)
            .decimal,
        })),
        rows,
      };
    });
    return {
      ok: true as const,
      scope: "week_projection_only" as const,
      cutoff: input.cutoff,
      rulesHash: input.frozenRulesHash,
      members,
      ...prepared,
    };
  } catch (error) {
    return {
      ok: false as const,
      scope: "week_projection_only" as const,
      blockers: [
        error instanceof Invalid ? error.message : "invalid_source_or_resolver",
      ],
    };
  }
}
/** Strict history requires explicit source-resolved times, categories and lifetime. */
export function legacyProjectionToShadow(input: StrictInput) {
  const week = compareLegacyWeek(input);
  if (!week.ok) return week;
  const blockers: string[] = [];
  try {
    const members: ShadowSnapshot[] = input.projection.members.map(
      (member, index) => {
        const projected = week.members[index];
        requireValue(projected, "missing_member");
        const rows: ShadowRow[] = [];
        const admit = (
          raw: RowContext,
          points: string,
          exclusionReason: string | null,
        ) => {
          const resolved = input.resolveRow(raw);
          if (!resolved) {
            blockers.push("unresolved_row_metadata");
            return;
          }
          requireValue(
            resolved.identityKey &&
              (raw.sourceCategory === null ||
                resolved.sourceCategory === raw.sourceCategory),
            "row_category_mismatch",
          );
          const at = instant(resolved.occurredAt);
          requireValue(
            at >= instant(input.projection.weekStart) &&
              at <= instant(input.cutoff),
            "row_outside_cutoff",
          );
          rows.push({
            key: rowKey(
              input,
              raw,
              resolved.identityKey,
              resolved.sourceCategory,
            ),
            category: mapped(input, resolved.sourceCategory),
            evidenceKeys: evidence(input, raw.evidence),
            points,
            status: raw.kind,
            occurredAt: resolved.occurredAt,
            ruleHash: input.frozenRulesHash,
            exclusionReason,
          });
        };
        for (const value of member.items)
          admit(
            context(member.userId, "accepted", value),
            exactPoints(value.points).decimal,
            null,
          );
        for (const value of member.pending)
          admit(context(member.userId, "pending", value), "0", null);
        for (const [url, value] of Object.entries(
          input.projection.sourceDispositions ?? {},
        )) {
          if (!["excluded", "merged"].includes(value.status)) continue;
          const owners = input.dispositionOwners(url);
          if (!owners?.length) {
            blockers.push("unresolved_disposition_ownership");
            continue;
          }
          requireValue(
            new Set(owners).size === owners.length &&
              owners.every((id) => input.roster.includes(id)),
            "invalid_disposition_ownership",
          );
          if (owners.includes(member.userId))
            admit(
              {
                userId: member.userId,
                kind: value.status === "merged" ? "superseded" : "excluded",
                sourceKey: url,
                sourceCategory: null,
                evidence: [url],
              },
              "0",
              token(input, "reason", value.reason),
            );
        }
        const lifetime = input.lifetimePoints(member.userId);
        if (lifetime === null) blockers.push("missing_lifetime_points");
        return {
          version: 1,
          provenance: "sanitized",
          subjectAlias: projected.subjectAlias,
          cutoff: input.cutoff,
          rulesHash: input.frozenRulesHash,
          complete: true,
          summary: {
            period: "week",
            start: input.projection.weekStart,
            end: input.cutoff,
            totalPoints: projected.totalPoints,
            lifetimePoints: exactPoints(lifetime ?? "0").decimal,
            pendingCount: member.pending.length,
            categories: projected.categories,
          },
          rows,
        };
      },
    );
    if (week.origin.coverageWarningsCount)
      blockers.push("source_coverage_warnings");
    if (blockers.length)
      return {
        ok: false as const,
        blockers: [...new Set(blockers)],
        sourceManifest: week.sourceManifest,
        origin: week.origin,
      };
    const shadow: RosterShadow = {
      version: 1,
      cutoff: input.cutoff,
      rulesHash: input.frozenRulesHash,
      roster: week.roster,
      members,
    };
    compareShadowRoster(week.roster, shadow, shadow);
    return {
      ok: true as const,
      shadow,
      sourceManifest: week.sourceManifest,
      origin: week.origin,
    };
  } catch (error) {
    return {
      ok: false as const,
      blockers: [
        error instanceof Invalid ? error.message : "invalid_source_or_resolver",
      ],
      sourceManifest: week.sourceManifest,
      origin: week.origin,
    };
  }
}
