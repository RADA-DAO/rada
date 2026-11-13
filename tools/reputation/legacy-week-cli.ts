import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compareLegacyWeek,
  legacyProjectionToShadow,
  type LegacyInput,
  type LegacyProjection,
} from "./legacy-projection.ts";
import type { Category } from "../../modules/reputation/index.ts";
/** Config and inputs stay private; this command never emits raw source values. */
export async function inspectLegacyWeekConfig(value: unknown) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    const config = value as Record<string, unknown>;
    if (
      typeof config.aliasSalt !== "string" ||
      !/^(?:[a-f0-9]{64}|[a-f0-9]{128})$/i.test(config.aliasSalt) ||
      typeof config.rulesCanonical !== "string" ||
      !Array.isArray(config.roster) ||
      !config.categoryMap ||
      typeof config.categoryMap !== "object"
    )
      throw new Error();
    const projection =
      typeof config.projection === "string"
        ? isAbsolute(config.projection)
          ? (JSON.parse(
              await readFile(config.projection, "utf8"),
            ) as LegacyProjection)
          : null
        : (config.projection as LegacyProjection);
    if (!projection) throw new Error();
    const salt = Buffer.from(config.aliasSalt, "hex");
    const input: LegacyInput = {
      projection,
      roster: config.roster as number[],
      cutoff:
        typeof config.cutoff === "string"
          ? config.cutoff
          : projection.assessedThrough,
      frozenRulesJson: config.rulesCanonical,
      frozenRulesHash: createHash("sha256")
        .update(config.rulesCanonical)
        .digest("hex"),
      categoryMap: config.categoryMap as Record<string, Category>,
      opaque: (scope, raw) =>
        createHmac("sha256", salt)
          .update(JSON.stringify([scope, raw]))
          .digest("hex"),
      ...(typeof config.expectedAssessmentHash === "string"
        ? { expectedAssessmentHash: config.expectedAssessmentHash }
        : {}),
      ...(typeof config.expectedFullReviewHash === "string"
        ? { expectedFullReviewHash: config.expectedFullReviewHash }
        : {}),
    };
    const week = compareLegacyWeek(input);
    if (!week.ok)
      return {
        ok: false as const,
        scope: week.scope,
        independentScoring: false,
        independentCandidate: false,
        blockers: week.blockers,
      };
    const strict = legacyProjectionToShadow({
      ...input,
      resolveRow: () => null,
      dispositionOwners: () => null,
      lifetimePoints: () => null,
    });
    const normalized = {
      ...week,
      roster: [...week.roster].sort(),
      members: [...week.members]
        .sort((a, b) => a.subjectAlias.localeCompare(b.subjectAlias))
        .map((member) => ({
          ...member,
          rows: [...member.rows].sort((a, b) => a.key.localeCompare(b.key)),
        })),
      sourceManifest: [...week.sourceManifest].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
    };
    return {
      ok: true as const,
      scope: week.scope,
      independentScoring: false,
      independentCandidate: false,
      checks: {
        members: week.members.length,
        zeroMembers: week.members.filter((member) => member.totalPoints === "0")
          .length,
        acceptedRows: week.members.reduce(
          (sum, member) =>
            sum + member.rows.filter((row) => row.status === "accepted").length,
          0,
        ),
        pendingRows: week.members.reduce(
          (sum, member) =>
            sum + member.rows.filter((row) => row.status === "pending").length,
          0,
        ),
        sourceExclusions: week.sourceManifest.length,
      },
      hashes: {
        assessment: week.origin.assessmentHash,
        rules: week.rulesHash,
        mappedProjection: createHash("sha256")
          .update(JSON.stringify(normalized))
          .digest("hex"),
      },
      migrationReadiness: {
        completeHistory: strict.ok,
        blockers: strict.ok ? [] : strict.blockers,
      },
    };
  } catch {
    return {
      ok: false as const,
      scope: "week_projection_only",
      independentScoring: false,
      independentCandidate: false,
      blockers: ["invalid_private_config_or_unreadable_source"],
    };
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let result: Awaited<ReturnType<typeof inspectLegacyWeekConfig>>;
  try {
    const path = process.argv[2];
    if (!path || !isAbsolute(path)) throw new Error();
    result = await inspectLegacyWeekConfig(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch {
    result = {
      ok: false,
      scope: "week_projection_only",
      independentScoring: false,
      independentCandidate: false,
      blockers: ["invalid_private_config_or_unreadable_source"],
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}
