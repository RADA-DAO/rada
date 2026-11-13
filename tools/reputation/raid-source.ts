import {
  actor,
  exact,
  hash,
  instant,
  requireValue,
  rule,
  unit,
  validatePeriod,
  type RaidComment,
  type RaidSourceInput,
  type RaidSourceResult,
} from "./raid-source-model.ts";
export type * from "./raid-source-model.ts";
const array = (value: unknown): boolean => Array.isArray(value);
const acceptedStatus = (value: unknown): boolean => value === "accepted";
/** Independent observed-units-v1 extraction. No served points/pending rows enter this function. */
export function buildRaidSource(input: RaidSourceInput): RaidSourceResult {
  const result: RaidSourceResult = {
    version: 1,
    weekStart: input.weekStart,
    cutoff: input.cutoff,
    rulesHash: input.frozenRulesHash,
    roster: [],
    facts: [],
    blocked: [],
    excluded: [],
    reviewedDispositions: {
      sourceDispositions: input.sourceDispositions ?? {},
      excludedComments: input.excludedComments ?? [],
      effectOnRaid: "audit_only_under_observed_units_v1",
    },
    scope: {
      kind: "raw_dated_raid_subset",
      independentCandidate: true,
      independentScoring: true,
      complete: false,
      excludedLanes: [
        "work",
        "content",
        "help",
        "voting",
        "submission",
        "events",
        "mafia",
        "chat",
        "pending",
        "lifetime",
        "money",
        "political_rights",
      ],
    },
  };
  let points: string;
  try {
    points = rule(input);
    validatePeriod(input.weekStart, input.cutoff);
    requireValue(
      array(input.roster) &&
        input.roster.every(actor) &&
        new Set(input.roster).size === input.roster.length,
      "invalid_roster",
    );
    requireValue(
      array(input.excludedActorIds) && input.excludedActorIds.every(actor),
      "missing_service_actor_context",
    );
    requireValue(
      array(input.posts) &&
        input.posts.length <= 100000 &&
        array(input.comments) &&
        input.comments.length <= 100000,
      "invalid_raw_sources",
    );
    requireValue(
      array(input.acceptedEventEntries),
      "missing_accepted_event_context",
    );
    requireValue(
      input.acceptedEventEntries.every(
        (e) =>
          acceptedStatus(e.status) &&
          actor(e.actorId) &&
          ["current", "prior"].includes(e.scope) &&
          typeof e.key === "string" &&
          array(e.evidence),
      ),
      "invalid_accepted_event_context",
    );
  } catch (error) {
    result.blocked.push({
      commentId: null,
      reason:
        error instanceof Error ? error.message : "invalid_policy_or_context",
    });
    return result;
  }
  const roster = new Set(
    input.roster.filter((id) => !input.excludedActorIds.includes(id)),
  );
  result.roster = [...roster].sort((a, b) => a - b);
  const posts = new Map(input.posts.map((post) => [post.url, post]));
  const conflictingPosts = new Set<string>();
  for (const post of input.posts)
    if (JSON.stringify(posts.get(post.url)) !== JSON.stringify(post))
      conflictingPosts.add(post.url);
  const comments = new Map<string, RaidComment>();
  const conflicts = new Set<string>();
  const signature = (c: RaidComment) =>
    JSON.stringify([
      c.authorId,
      c.eventAt,
      c.postUrl,
      c.text,
      c.bot ?? false,
      c.forwarded ?? false,
      c.deleted ?? false,
    ]);
  for (const c of input.comments) {
    const prior = comments.get(c.url);
    if (prior && signature(prior) !== signature(c)) conflicts.add(c.url);
    comments.set(c.url, c);
  }
  const first = instant(input.weekStart);
  const cutoff = instant(input.cutoff);
  const accepted = new Set<string>();
  for (const entry of input.acceptedEventEntries) {
    if (entry.key.startsWith("event-entry:"))
      accepted.add(JSON.stringify([entry.actorId, entry.key.slice(12)]));
    if (entry.scope !== "current" || entry.category !== "events") continue;
    for (const url of entry.evidence) {
      const comment = comments.get(url);
      const post = comment ? posts.get(comment.postUrl) : undefined;
      if (post) {
        try {
          accepted.add(JSON.stringify([entry.actorId, unit(post)]));
        } catch {
          /* Affected source is blocked below. */
        }
      }
    }
  }
  const groups = new Map<
    string,
    { actorId: number; identity: string; comments: RaidComment[] }
  >();
  for (const c of comments.values()) {
    const id = String(c.id);
    const skip = (reason: string) => {
      result.excluded.push({ commentId: id, reason });
    };
    try {
      requireValue(!conflicts.has(c.url), "conflicting_comment_identity");
      requireValue(actor(c.authorId), "missing_comment_actor");
      if (!roster.has(c.authorId)) {
        skip("outside_scoring_roster");
        continue;
      }
      const post = posts.get(c.postUrl);
      requireValue(
        post && !conflictingPosts.has(post.url),
        "missing_or_conflicting_post",
      );
      requireValue(
        typeof post.author === "number" &&
          Number.isSafeInteger(post.author) &&
          post.author !== 0,
        "missing_post_owner",
      );
      if (c.authorId === post.author) {
        skip("own_post");
        continue;
      }
      const at = instant(c.eventAt);
      requireValue(at % 1000n === 0n, "submicrosecond_event_time");
      if (at < first || at > cutoff) {
        skip("outside_cutoff");
        continue;
      }
      requireValue(
        [c.bot, c.deleted, c.forwarded].every(
          (flag) => flag === undefined || typeof flag === "boolean",
        ),
        "invalid_source_flags",
      );
      if (c.bot || c.deleted || c.forwarded) {
        skip("bot_deleted_or_forwarded");
        continue;
      }
      requireValue(
        typeof c.text === "string" &&
          typeof c.url === "string" &&
          /^https:\/\/\S+$/.test(c.url),
        "invalid_comment_evidence",
      );
      if (/^\/\S+$/.test(c.text.trim())) {
        skip("command");
        continue;
      }
      const identity = unit(post);
      const key = JSON.stringify([c.authorId, identity]);
      if (accepted.has(key)) {
        skip("accepted_event_entry_precedence");
        continue;
      }
      const group = groups.get(key) ?? {
        actorId: c.authorId,
        identity,
        comments: [],
      };
      group.comments.push(c);
      groups.set(key, group);
    } catch (error) {
      result.blocked.push({
        commentId: id,
        reason: error instanceof Error ? error.message : "invalid_dated_source",
      });
    }
  }
  for (const group of groups.values()) {
    const sorted = [...group.comments].sort((a, b) =>
      instant(a.eventAt) < instant(b.eventAt)
        ? -1
        : instant(a.eventAt) > instant(b.eventAt)
          ? 1
          : a.url.localeCompare(b.url),
    );
    const anchor = sorted[0];
    if (!anchor) continue;
    const semanticKey = hash(
      JSON.stringify([
        "observed-raid",
        group.actorId,
        instant(input.weekStart).toString(),
        group.identity,
      ]),
    );
    result.facts.push({
      actorId: group.actorId,
      key: `raid:${group.identity}`,
      sourceId: `observed-raid:${semanticKey}`,
      semanticKey,
      rulesHash: input.frozenRulesHash,
      ruleKey: "participation.distinctRaidPost",
      points,
      category: "participation",
      sourceCategory: "raid",
      occurredAt: anchor.eventAt,
      anchorEvidenceUrl: anchor.url,
      evidence: [...new Set(sorted.map((c) => c.url))].sort().slice(0, 50),
      rawCommentCount: sorted.length,
    });
  }
  result.facts.sort(
    (a, b) => a.actorId - b.actorId || a.key.localeCompare(b.key),
  );
  result.scope.complete = result.blocked.length === 0;
  return result;
}
export type RaidServed = {
  weekStart: string;
  assessedThrough: string;
  rulesHash: string;
  members: readonly {
    userId: number;
    items: readonly {
      key: string;
      category: string;
      points: string;
      evidence: readonly string[];
    }[];
  }[];
};
/** Only raid leaves are comparable. Every other legacy lane remains explicitly outside this scope. */
export function compareRaidSource(
  candidate: RaidSourceResult,
  served: RaidServed,
) {
  const problems: string[] = [];
  if (!candidate.scope.complete) problems.push("blocked_raw_source");
  if (
    instant(candidate.weekStart) !== instant(served.weekStart) ||
    instant(candidate.cutoff) !== instant(served.assessedThrough) ||
    candidate.rulesHash !== served.rulesHash
  )
    problems.push("source_context_mismatch");
  const servedRoster = served.members
    .map((member) => member.userId)
    .sort((a, b) => a - b);
  if (JSON.stringify(candidate.roster) !== JSON.stringify(servedRoster))
    problems.push("served_roster_mismatch");
  const expected = new Map(
    candidate.facts.map((f) => [
      JSON.stringify([f.actorId, f.key]),
      { points: f.points, evidence: f.evidence, category: f.sourceCategory },
    ]),
  );
  const actual = new Map<
    string,
    { points: string; evidence: string[]; category: string }
  >();
  let other = 0;
  for (const member of served.members)
    for (const item of member.items) {
      if (item.category !== "raid" && !item.key.startsWith("raid:")) {
        other++;
        continue;
      }
      const key = JSON.stringify([member.userId, item.key]);
      if (new Set(item.evidence).size !== item.evidence.length)
        problems.push("duplicate_served_evidence");
      if (actual.has(key)) problems.push("duplicate_served_raid_key");
      actual.set(key, {
        points: exact(item.points).decimal,
        evidence: [...new Set(item.evidence)].sort(),
        category: item.category,
      });
    }
  const differences = [...new Set([...expected.keys(), ...actual.keys()])]
    .sort()
    .filter(
      (key) =>
        JSON.stringify(expected.get(key)) !== JSON.stringify(actual.get(key)),
    );
  const sum = (rows: Iterable<{ points: string }>) =>
    [...rows]
      .reduce((total, row) => total + exact(row.points).units, 0n)
      .toString();
  return {
    scope: candidate.scope.kind,
    comparable: problems.length === 0,
    equal: problems.length === 0 && differences.length === 0,
    problems,
    differences,
    expectedRaidUnits: expected.size,
    servedRaidUnits: actual.size,
    expectedPointsScale10000: sum(expected.values()),
    servedPointsScale10000: sum(actual.values()),
    excludedOtherLaneRows: other,
    excludedLanes: candidate.scope.excludedLanes,
  };
}
