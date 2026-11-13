import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { LegacyProjection } from "./legacy-projection.ts";
import type { AcceptedEventEntry, RaidSourceInput } from "./raid-source.ts";
const sha = (raw: Uint8Array | string) =>
  createHash("sha256").update(raw).digest("hex");
type ManifestFile = { capture: string; sha256: string; bytes: number };
type Manifest = {
  stable: boolean;
  files: Record<string, ManifestFile>;
  registry: { snapshot: string; sha256: string };
};
type Inputs = {
  roster: { telegramId: number }[];
  posts: RaidSourceInput["posts"];
  comments: RaidSourceInput["comments"];
  excludedComments?: string[];
};
export async function loadRaidCapture(path: string) {
  const directory = resolve(path);
  const json = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(resolve(directory, name), "utf8")) as T;
  const manifest = await json<Manifest>("manifest.json");
  assert.equal(manifest.stable, true, "capture_not_stable");
  assert.ok(Object.keys(manifest.files).length <= 512);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const [role, entry] of Object.entries(manifest.files)) {
    const target = resolve(directory, entry.capture);
    assert.ok(target.startsWith(directory + sep), "capture_path_escape");
    const raw = await readFile(target);
    total += raw.length;
    assert.ok(total <= 64 * 1024 * 1024, "capture_size_limit");
    assert.equal(raw.length, entry.bytes);
    assert.equal(sha(raw), entry.sha256, "capture_hash_mismatch");
    files.set(role, raw);
  }
  const registryPath = resolve(directory, manifest.registry.snapshot);
  assert.ok(registryPath.startsWith(directory + sep), "registry_path_escape");
  assert.equal(
    sha(await readFile(registryPath)),
    manifest.registry.sha256,
    "registry_capture_hash_mismatch",
  );
  const required = (role: string) => {
    const raw = files.get(role);
    assert.ok(raw, `capture_missing_${role}`);
    return raw;
  };
  const derived = await readFile(resolve(directory, "inputs-raid.json"));
  const provenance = await json<{
    sourceHash: string;
    derivedHash: string;
    transformation: string;
  }>("inputs-raid-provenance.json");
  assert.equal(provenance.sourceHash, sha(required("inputs")));
  assert.equal(provenance.derivedHash, sha(derived));
  assert.equal(
    provenance.transformation,
    "post.album integer to exact decimal string only",
  );
  const exclusions = await readFile(resolve(directory, "excluded-actors.json"));
  const exclusionsProvenance = await json<{
    sourceHash: string;
    derivedHash: string;
    transformation: string;
  }>("excluded-actors-provenance.json");
  assert.equal(
    exclusionsProvenance.sourceHash,
    sha(required("code/member_scores.py")),
  );
  assert.equal(exclusionsProvenance.derivedHash, sha(exclusions));
  assert.equal(
    exclusionsProvenance.transformation,
    "literal OBSERVER exclusion from captured member_scores.py",
  );
  // Python preserves arbitrary integer IDs and the two original canonical JSON conventions.
  const proof = JSON.parse(
    execFileSync(
      "python3",
      [
        "-c",
        `
import hashlib,json,sys
from pathlib import Path
p=Path(sys.argv[1]);load=lambda n:json.loads((p/n).read_bytes())
hash=lambda d,compact=False:hashlib.sha256(json.dumps(d,ensure_ascii=False,sort_keys=True,**({'separators':(',',':')} if compact else {})).encode()).hexdigest()
r=load('registry.json');e=load('source-epoch.json');s=load('served.json')
registry=hash({k:v for k,v in r.items() if k!='registryHash'},True)
expected=hash({'seed':load('reviewed.json'),'input':load('inputs.json'),'registryHash':r['registryHash']})
print(json.dumps({'matches':registry==r['registryHash'] and e.get('matches') is True and expected==s['assessmentHash']==e['expectedAssessmentHash'],'hash':expected}))
`,
        directory,
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 4096,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    ),
  ) as { matches: boolean; hash: string };
  assert.equal(proof.matches, true, "source_epoch_waiting");
  const inputs = JSON.parse(derived.toString("utf8")) as Inputs;
  const served = JSON.parse(
    required("served").toString("utf8"),
  ) as LegacyProjection;
  const reviewed = JSON.parse(
    required("reviewed").toString("utf8"),
  ) as LegacyProjection;
  const rules = required("rules").toString("utf8");
  assert.equal(sha(rules), served.rulesHash, "rules_canonical_bytes_mismatch");
  const excludedActorIds = JSON.parse(exclusions.toString("utf8")) as number[];
  assert.ok(
    Array.isArray(excludedActorIds) &&
      excludedActorIds.every((id) => Number.isSafeInteger(id) && id > 0),
  );
  const roster = inputs.roster.map((row) => row.telegramId);
  assert.ok(roster.every((id) => Number.isSafeInteger(id) && id > 0));
  assert.equal(new Set(roster).size, roster.length);
  const expectedRoster = roster.filter((id) => !excludedActorIds.includes(id));
  assert.deepEqual(
    [...expectedRoster].sort((a, b) => a - b),
    served.members.map((member) => member.userId).sort((a, b) => a - b),
    "full_roster_or_zero_omission",
  );
  const acceptedEventEntries: AcceptedEventEntry[] = [];
  const addEntries = (
    projection: LegacyProjection,
    scope: "current" | "prior",
  ) => {
    for (const member of projection.members)
      for (const item of member.items) {
        if (!(
          item.key.startsWith("event-entry:") ||
          (scope === "current" && item.category === "events")
        ))
          continue;
        acceptedEventEntries.push({
          actorId: member.userId,
          status: "accepted",
          scope,
          key: item.key,
          category: item.category,
          evidence: item.evidence,
        });
      }
  };
  addEntries(reviewed, "current");
  for (const [role, raw] of files)
    if (role.startsWith("prior/")) {
      const prior = JSON.parse(raw.toString("utf8")) as LegacyProjection;
      if (Date.parse(prior.weekStart) < Date.parse(served.weekStart))
        addEntries(prior, "prior");
    }
  const input: RaidSourceInput = {
    weekStart: served.weekStart,
    cutoff: served.assessedThrough,
    frozenRulesJson: rules,
    frozenRulesHash: served.rulesHash,
    roster,
    excludedActorIds,
    posts: inputs.posts,
    comments: inputs.comments,
    acceptedEventEntries,
    ...(reviewed.sourceDispositions
      ? { sourceDispositions: reviewed.sourceDispositions }
      : {}),
    ...(inputs.excludedComments
      ? { excludedComments: inputs.excludedComments }
      : {}),
  };
  return {
    input,
    served,
    expectedRoster,
    sourceEpoch: proof.hash,
    normalizedInputHash: sha(derived),
    excludedActorsHash: sha(exclusions),
  };
}
export function privateAliases() {
  const configured = process.env.REPUTATION_SHADOW_HMAC_KEY;
  if (configured) assert.ok(configured.length >= 32, "alias_key_too_short");
  const secret = configured ? Buffer.from(configured) : randomBytes(32);
  const opaque = (scope: string, value: string) =>
    createHmac("sha256", secret)
      .update(JSON.stringify([scope, value]))
      .digest("hex");
  const actor = (id: number) =>
    String(
      7000000000000n + BigInt(`0x${opaque("actor", String(id)).slice(0, 10)}`),
    );
  return { actor, opaque };
}

/** Known credits may be checked in SQL without declaring incomplete raw coverage green. */
export function allowKnownRaidSubset(comparison: {
  problems: readonly string[];
  differences: readonly unknown[];
}): boolean {
  return (
    comparison.differences.length === 0 &&
    (comparison.problems.length === 0 ||
      (comparison.problems.length === 1 &&
        comparison.problems[0] === "blocked_raw_source"))
  );
}
