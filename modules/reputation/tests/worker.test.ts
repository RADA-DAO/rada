import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BoundedEvaluator,
  type EvaluationBudget,
  type ClassificationProvider,
} from "../worker/evaluator.ts";
import {
  freezeRules,
  propose,
  type AttributedEvidence,
} from "../worker/policy.ts";
import {
  membershipVerifier,
  telegramReadClient,
  type TelegramReadMethod,
} from "../worker/membership.ts";
const rules = freezeRules({
  hash: "synthetic-frozen-v1",
  rules: [
    {
      key: "synthetic.draft",
      points: "1.2345",
      category: "work",
      cap: { unit: "occurrence", limit: 1 },
    },
  ],
});
const evidence: AttributedEvidence = {
  subjectId: "synthetic-person",
  sourceId: "report-a",
  occurrenceKey: "result-a",
  kind: "self_report",
  content: "Completed an original synthetic draft",
  completedClaim: true,
  contradictions: [],
};
const output = {
  classification: "concrete_completed",
  ruleKey: "synthetic.draft",
  reason: "Concrete completed draft",
} as const;
const budget: EvaluationBudget = {
  maxConcurrent: 1,
  maxTokensPerCall: 128,
  costUnitsPerCall: 2,
  totalCostUnits: 4,
  deadlineMs: 1000,
};
void test("Trust accepts concrete completed attributed self-report without attachment; score stays policy-owned", async () => {
  const requests: Parameters<ClassificationProvider>[0][] = [];
  const evaluator = new BoundedEvaluator(rules, budget, async (request) => {
    await Promise.resolve();
    requests.push(request);
    return output;
  });
  const result = await evaluator.evaluate(evidence);
  assert.equal(result.state, "proposed");

  assert.equal(result.points, "1.2345");
  assert.equal(result.subjectId, evidence.subjectId);
  assert.equal(result.category, "work");
  assert.deepEqual(result.cap, { unit: "occurrence", limit: 1 });
  const request = requests[0];
  assert.ok(request);
  assert.deepEqual(Object.keys(request).sort(), [
    "content",
    "maxCostUnits",
    "maxTokens",
    "ruleKeys",
    "signal",
  ]);
  assert.equal(request.maxTokens, 128);
  assert.equal(request.maxCostUnits, 2);
  const changedPolicy = freezeRules({
    hash: "synthetic-v2",
    rules: [
      {
        ...rules.rules[0],
        key: "different.rule",
        points: "2",
        category: "help",
        cap: { unit: "occurrence", limit: 1 },
      },
    ],
  });
  const reclassified = propose(changedPolicy, evidence, {
    ...output,
    ruleKey: "different.rule",
  });
  assert.equal(reclassified.state, "proposed");
  assert.equal(result.semanticKey, reclassified.semanticKey);
});
void test("model score/subject/contradiction overrides are rejected; unknown/unclear never revoke", async () => {
  for (const override of [
    { points: "999" },
    { subjectId: "victim" },
    { contradictions: ["invented"] },
    { money: "1" },
  ]) {
    const evaluator = new BoundedEvaluator(rules, budget, () =>
      Promise.resolve({
        ...output,
        ...override,
      }),
    );
    assert.deepEqual(await evaluator.evaluate(evidence), {
      state: "needs_interpretation",
      reason: "invalid_provider_output",
    });
  }
  assert.deepEqual(
    propose(rules, evidence, { ...output, ruleKey: "unknown" }),
    { state: "needs_interpretation", reason: "unknown_rule" },
  );
  assert.equal(
    propose(rules, evidence, { ...output, classification: "not_completed" })
      .state,
    "needs_interpretation",
  );
});
void test("actual contradictory facts and incomplete claims bypass provider and preserve attribution snapshot", async () => {
  let called = 0;
  const evaluator = new BoundedEvaluator(rules, budget, async () => {
    await Promise.resolve();
    called++;
    return output;
  });
  assert.deepEqual(
    await evaluator.evaluate({
      ...evidence,
      contradictions: [
        {
          id: "trusted-source",
          detail: "The same result was explicitly withdrawn",
        },
      ],
    }),
    { state: "needs_interpretation", reason: "contradictory_facts" },
  );
  assert.equal(
    (await evaluator.evaluate({ ...evidence, completedClaim: false })).state,
    "needs_interpretation",
  );
  assert.equal(called, 0);
  const mutable = { ...evidence };
  const pending = evaluator.evaluate(mutable);
  mutable.subjectId = "changed-after-call";
  const result = await pending;
  assert.equal(result.state, "proposed");
  assert.equal(result.subjectId, evidence.subjectId);
});
void test("provider timeout retains occupied slot until non-cooperative call settles", async () => {
  let release: (value: unknown) => void = () => {};
  let signal: AbortSignal | undefined;
  const evaluator = new BoundedEvaluator(
    rules,
    { ...budget, deadlineMs: 15 },
    (request) => {
      signal = request.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  );
  const first = evaluator.evaluate(evidence);
  assert.deepEqual(await evaluator.evaluate(evidence), {
    state: "retry",
    reason: "capacity",
  });
  assert.deepEqual(await first, { state: "retry", reason: "timeout" });
  assert.equal(signal?.aborted, true);
  assert.equal(evaluator.counters().active, 1);
  assert.deepEqual(await evaluator.evaluate(evidence), {
    state: "retry",
    reason: "capacity",
  });
  release(output);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(evaluator.counters().active, 0);
});
void test("provider limit/abort/budget become retry, with worst-case budget reserved before calls", async () => {
  const limited = new BoundedEvaluator(rules, budget, async () => {
    await Promise.resolve();
    throw Object.assign(new Error("provider secret must not escape"), {
      code: "provider_limit",
    });
  });
  assert.deepEqual(await limited.evaluate(evidence), {
    state: "retry",
    reason: "provider_limit",
  });
  assert.deepEqual(await limited.evaluate(evidence), {
    state: "retry",
    reason: "provider_limit",
  });
  assert.deepEqual(await limited.evaluate(evidence), {
    state: "retry",
    reason: "budget",
  });
  const controller = new AbortController();
  controller.abort();
  const fresh = new BoundedEvaluator(rules, budget, () =>
    Promise.resolve(output),
  );
  assert.deepEqual(await fresh.evaluate(evidence, controller.signal), {
    state: "retry",
    reason: "aborted",
  });
  assert.equal(fresh.counters().reservedCostUnits, 0);
});
void test("frozen rules reject unknown fields, duplicate keys, unrepresentable points and missing budgets", () => {
  const rule = rules.rules[0];
  assert.ok(rule);
  for (const points of [
    "0.00001",
    "1.0000",
    "900000000000000000000",
    "-1",
    "NaN",
  ])
    assert.throws(() =>
      freezeRules({ hash: "x", rules: [{ ...rule, points }] }),
    );
  assert.throws(() => freezeRules({ ...rules, score: "999" }));
  assert.throws(() => freezeRules({ hash: "x", rules: [rule, rule] }));
  const missing = { ...budget };
  Reflect.deleteProperty(missing, "maxTokensPerCall");
  assert.throws(
    () => new BoundedEvaluator(rules, missing, () => Promise.resolve(output)),
  );
  assert.ok(
    Object.isFrozen(rules) &&
      Object.isFrozen(rule) &&
      Object.isFrozen(rule.cap),
  );
});
const config = {
  missionId: "synthetic-subscription",
  channelId: "-100123456789",
  proofUrl: "https://t.me/synthetic_public_channel",
};
const memberInput = {
  missionId: config.missionId,
  subjectId: "synthetic-person",
  telegramUserId: "987654321",
};
function fakeTelegram(
  options: {
    authority?: string;
    status?: string;
    wrongChat?: boolean;
    wrongUser?: boolean;
    oversized?: boolean;
    fail?: TelegramReadMethod;
  } = {},
) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    await Promise.resolve();
    const url = new URL(input instanceof Request ? input.url : input);
    const method = url.pathname.split("/").at(-1) ?? "";
    assert.equal(url.origin, "https://api.telegram.org");
    assert.equal(init?.method, "POST");
    assert.equal(init.redirect, "error");
    assert.ok(typeof init.body === "string");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ method, body });
    if (options.oversized) return new Response("x".repeat(65537));
    if (method === options.fail)
      return Response.json({ ok: false, error_code: 429 });
    const result =
      method === "getMe"
        ? { id: 12345, is_bot: true }
        : method === "getChat"
          ? {
              id: options.wrongChat ? -100999 : Number(config.channelId),
              type: "channel",
            }
          : {
              user: {
                id:
                  options.wrongUser && body.user_id !== 12345
                    ? 111
                    : body.user_id,
              },
              status:
                body.user_id === 12345
                  ? (options.authority ?? "administrator")
                  : (options.status ?? "member"),
            };
    return Response.json({ ok: true, result });
  };
  // Deliberately synthetic transport credential, never a real bot token.
  return {
    calls,
    client: telegramReadClient(
      () => ["1", "synthetic-fixture"].join(":"),
      fetcher,
    ),
  };
}
void test("membership uses expected channel, proves bot authority and checks only relevant user", async () => {
  const fake = fakeTelegram();
  const verify = membershipVerifier(config, fake.client);
  const result = await verify(memberInput, new AbortController().signal);
  assert.equal(result.state, "verified");
  assert.equal(result.subjectId, memberInput.subjectId);
  assert.equal(result.proofUrl, config.proofUrl);
  assert.deepEqual(
    fake.calls.map((call) => call.method),
    ["getMe", "getChat", "getChatMember", "getChatMember"],
  );
  assert.deepEqual(
    fake.calls.slice(1).map((call) => call.body.chat_id),
    Array(3).fill(config.channelId),
  );
  assert.equal(fake.calls[2]?.body.user_id, 12345);
  assert.equal(fake.calls[3]?.body.user_id, Number(memberInput.telegramUserId));
  assert.deepEqual(
    await verify(
      { ...memberInput, channelId: "-100999" } as typeof memberInput,
      new AbortController().signal,
    ),
    { state: "checking", reason: "invalid_input" },
  );
  assert.equal(fake.calls.length, 4);
});
void test("missing authority, wrong channel/user, nonmembers, limits and errors remain checking", async () => {
  for (const [options, reason] of [
    [{ authority: "member" }, "authority_unavailable"],
    [{ wrongChat: true }, "authority_unavailable"],
    [{ wrongUser: true }, "unavailable"],
    [{ status: "left" }, "membership_absent"],
    [{ status: "kicked" }, "membership_absent"],
    [{ status: "restricted" }, "unavailable"],
    [{ fail: "getChatMember" }, "unavailable"],
    [{ oversized: true }, "unavailable"],
  ] as const) {
    const fake = fakeTelegram(options);
    assert.deepEqual(
      await membershipVerifier(config, fake.client)(
        memberInput,
        new AbortController().signal,
      ),
      { state: "checking", reason },
    );
  }
});
void test("unconfigured/aborted membership has no network side effects; proof configuration is trusted and pinned", async () => {
  const fake = fakeTelegram();
  assert.deepEqual(
    await membershipVerifier(null, fake.client)(
      memberInput,
      new AbortController().signal,
    ),
    { state: "checking", reason: "unconfigured" },
  );
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(
    await membershipVerifier(config, fake.client)(
      memberInput,
      controller.signal,
    ),
    { state: "checking", reason: "unavailable" },
  );
  assert.equal(fake.calls.length, 0);
  assert.throws(() =>
    membershipVerifier(
      { ...config, channelId: "@untrusted_alias" },
      fake.client,
    ),
  );
  assert.throws(() =>
    membershipVerifier(
      { ...config, proofUrl: "https://evil.test" },
      fake.client,
    ),
  );
});

void test("unconfigured evaluator avoids provider calls and active cancellation forwards abort", async () => {
  let called = 0;
  const provider: ClassificationProvider = (request) => {
    called++;
    return new Promise((_, reject) => {
      request.signal.addEventListener(
        "abort",
        () => {
          reject(new Error("aborted fixture"));
        },
        { once: true },
      );
    });
  };
  const empty = new BoundedEvaluator(
    freezeRules({ hash: "empty", rules: [] }),
    budget,
    provider,
  );
  assert.deepEqual(await empty.evaluate(evidence), {
    state: "needs_interpretation",
    reason: "unconfigured",
  });
  assert.equal(called, 0);
  const evaluator = new BoundedEvaluator(rules, budget, provider);
  const controller = new AbortController();
  const result = evaluator.evaluate(evidence, controller.signal);
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await result, { state: "retry", reason: "aborted" });
  await Promise.resolve();
  assert.equal(evaluator.counters().active, 0);
});
void test("read transport denies unsupported methods before fetching", async () => {
  const fake = fakeTelegram();
  await assert.rejects(
    fake.client(
      "getUpdates" as TelegramReadMethod,
      {},
      new AbortController().signal,
    ),
    /unsupported_telegram_method/,
  );
  assert.equal(fake.calls.length, 0);
});
