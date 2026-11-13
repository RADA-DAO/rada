import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type {
  Category,
  ItemStatus,
  Summary,
} from "../modules/reputation/contract.ts";

/** Explicit offline envelope, not a new API response or production import format. */
export type ShadowSnapshot = {
  version: 1;
  provenance: "synthetic" | "sanitized";
  subjectAlias: string;
  cutoff: string;
  rulesHash: string;
  complete: true;
  summary: Pick<
    Summary,
    | "period"
    | "start"
    | "end"
    | "totalPoints"
    | "lifetimePoints"
    | "pendingCount"
    | "categories"
  >;
  rows: {
    key: string;
    points: string;
    status: ItemStatus;
    occurredAt: string;
    ruleHash: string | null;
    exclusionReason: string | null;
  }[];
};
const categories: Category[] = ["content", "help", "participation", "work"];
const decimal = /^(?:0|-?[1-9]\d*)(?:\.\d{0,3}[1-9])?$|^-0\.\d{0,3}[1-9]$/;
function validate(snapshot: ShadowSnapshot): void {
  assert.equal(snapshot.version, 1);
  assert.ok(["synthetic", "sanitized"].includes(snapshot.provenance));
  assert.equal(
    snapshot.complete,
    true,
    "partial pages cannot establish parity",
  );
  assert.ok(snapshot.subjectAlias && snapshot.rulesHash);
  assert.ok(Number.isFinite(Date.parse(snapshot.cutoff)));
  assert.ok(
    ["all", "today", "week", "previous_week"].includes(snapshot.summary.period),
  );
  assert.ok(Number.isFinite(Date.parse(snapshot.summary.end)));
  assert.ok(
    snapshot.summary.start === null ||
      Number.isFinite(Date.parse(snapshot.summary.start)),
  );
  for (const points of [
    snapshot.summary.totalPoints,
    snapshot.summary.lifetimePoints,
    ...snapshot.summary.categories.map((entry) => entry.points),
    ...snapshot.rows.map((row) => row.points),
  ]) {
    assert.match(points, decimal, "points must be canonical exact decimals");
  }
  assert.ok(
    Number.isSafeInteger(snapshot.summary.pendingCount) &&
      snapshot.summary.pendingCount >= 0,
  );
  assert.deepEqual(
    snapshot.summary.categories.map((entry) => entry.category).sort(),
    categories,
    "all four categories, including explicit zeros, are required",
  );
  assert.equal(
    new Set(snapshot.rows.map((row) => row.key)).size,
    snapshot.rows.length,
    "duplicate comparison keys",
  );
  for (const row of snapshot.rows) {
    assert.ok(
      row.key &&
        ["accepted", "pending", "excluded", "superseded"].includes(row.status),
    );
    assert.ok(Number.isFinite(Date.parse(row.occurredAt)));
    assert.ok(row.ruleHash === null || typeof row.ruleHash === "string");
    assert.ok(
      row.exclusionReason === null || typeof row.exclusionReason === "string",
    );
    if (row.status !== "accepted") assert.equal(row.points, "0");
    if (row.status === "excluded" || row.status === "superseded")
      assert.ok(row.exclusionReason, "exclusions must be explicit");
  }
}
/** Compares supplied truth; never calculates awards or infers historical weights. */
export function compareShadow(
  left: ShadowSnapshot,
  right: ShadowSnapshot,
): { equal: boolean; differences: string[] } {
  validate(left);
  validate(right);
  for (const key of ["subjectAlias", "cutoff", "rulesHash"] as const)
    assert.equal(left[key], right[key], `incomparable ${key}`);
  const normalized = (value: ShadowSnapshot) => ({
    ...value.summary,
    categories: [...value.summary.categories].sort((a, b) =>
      a.category.localeCompare(b.category),
    ),
    rows: [...value.rows].sort((a, b) => a.key.localeCompare(b.key)),
  });
  const a = normalized(left);
  const b = normalized(right);
  const differences = (Object.keys(a) as (keyof typeof a)[]).filter((key) => {
    try {
      assert.deepEqual(a[key], b[key]);
      return false;
    } catch {
      return true;
    }
  });
  return { equal: differences.length === 0, differences };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [leftPath, rightPath] = process.argv.slice(2);
    assert.ok(
      leftPath && rightPath,
      "usage: node --experimental-strip-types tools/reputation-shadow.ts LEFT.json RIGHT.json",
    );
    const left = JSON.parse(await readFile(leftPath, "utf8")) as ShadowSnapshot;
    const right = JSON.parse(
      await readFile(rightPath, "utf8"),
    ) as ShadowSnapshot;
    const result = compareShadow(left, right);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.equal) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid shadow input"}\n`,
    );
    process.exitCode = 2;
  }
}
