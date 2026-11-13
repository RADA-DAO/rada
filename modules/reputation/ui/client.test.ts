import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ModuleApi,
  ModuleResponse,
} from "../../../packages/platform-sdk/src/index.ts";
import type { CommandResult, Mission, Summary } from "../contract.ts";
import { reputationClient } from "./client.ts";
import { createAppealActions } from "./appeals.ts";
import { commandActions, type Pending } from "./commands.ts";
import { ReadGuard, ReputationError, command, summary } from "./model.ts";
import { recoveryStore } from "./recovery.ts";
import { Button } from "../../../packages/ui/src/index.ts";
import "../../../packages/ui/scripts/fake-dom.ts";
const stamp = "2026-11-13T12:00:00.000Z";
const requestId = "00000000-0000-4000-8000-000000000001";
const baseSummary: Summary = {
  version: 1,
  revision: "10",
  period: "today",
  start: stamp,
  end: stamp,
  totalPoints: "2.5",
  lifetimePoints: "3.5",
  pendingCount: 0,
  categories: [{ category: "help", points: "2.5" }],
  updatedAt: stamp,
};
const receipt: CommandResult = {
  version: 1,
  requestId,
  state: "completed",
  summary: baseSummary,
  item: {
    id: "synthetic-item",
    title: "Synthetic contribution",
    category: "help",
    points: "2.5",
    status: "accepted",
    reason: "Synthetic check",
    occurredAt: stamp,
    recordedAt: stamp,
    ruleHash: null,
    evidence: [],
    missionId: "synthetic-mission",
  },
};
const mission: Mission = {
  id: "synthetic-mission",
  version: 1,
  title: "Synthetic task",
  description: "Synthetic acknowledgement",
  category: "help",
  points: "2.5",
  ruleHash: "synthetic-rule",
  verifier: "acknowledgement",
  status: "available",
  actionUrl: null,
};
function api(run: ModuleApi["request"]): ModuleApi {
  return { url: (path) => path, request: run };
}
function response(body: unknown, status = 200): ModuleResponse {
  return { body, status, retryAfter: null };
}
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
await test("wire parsing rejects malformed decimals, counters and receipts", () => {
  assert.equal(summary(baseSummary).totalPoints, "2.5");
  for (const invalid of ["2.00001", 2.5, "1e3", "NaN"])
    assert.throws(
      () => summary({ ...baseSummary, totalPoints: invalid }),
      ReputationError,
    );
  assert.throws(
    () => summary({ ...baseSummary, pendingCount: -1 }),
    ReputationError,
  );
  assert.throws(() => command({ ...receipt, summary: null }), ReputationError);
});
await test("older reads and reversed receipts cannot erase confirmed progress", () => {
  const guard = new ReadGuard();
  const old = guard.begin();
  guard.receipt(baseSummary);
  assert.equal(guard.accept(old, { ...baseSummary, revision: "9" }), false);
  guard.receipt({ ...baseSummary, revision: "8" });
  const fresh = guard.begin();
  assert.equal(guard.accept(fresh, { ...baseSummary, revision: "9" }), false);
  assert.equal(guard.accept(fresh, baseSummary), true);
  const next = guard.begin();
  assert.equal(guard.accept(fresh, baseSummary), false);
  assert.equal(guard.accept(next, baseSummary), true);
  guard.invalidate();
  assert.equal(guard.accept(next, baseSummary), false);
});
await test("uncertain retry recovers command without repeating POST", async () => {
  const calls: string[] = [];
  const client = reputationClient(
    api((method, path) => {
      calls.push(`${method} ${path}`);
      if (method === "POST") throw new Error("lost response");
      return Promise.resolve(response(receipt));
    }),
    new AbortController().signal,
  );
  const body = { requestId, missionVersion: 1 };
  await assert.rejects(
    client.execute("/missions/synthetic-mission/verify", body, false),
  );
  assert.deepEqual(
    await client.execute("/missions/synthetic-mission/verify", body, true),
    receipt,
  );
  assert.deepEqual(calls, [
    "POST /v1/reputation/missions/synthetic-mission/verify",
    `GET /v1/reputation/commands/${requestId}`,
  ]);
});
await test("404 recovery resends identical payload; wrong command identity never resends", async () => {
  const body = { requestId, missionVersion: 1 };
  const writes: unknown[] = [];
  const client = reputationClient(
    api((method, _path, options) => {
      if (method === "GET") return Promise.resolve(response(null, 404));
      writes.push(options?.body);
      return Promise.resolve(response(receipt));
    }),
    new AbortController().signal,
  );
  await client.execute("/missions/synthetic-mission/verify", body, true);
  assert.deepEqual(writes, [{ json: body }]);
  const wrong = reputationClient(
    api(() => Promise.resolve(response({ ...receipt, requestId: "other" }))),
    new AbortController().signal,
  );
  await assert.rejects(
    wrong.execute(
      "/reports",
      {
        requestId,
        title: "Synthetic",
        description: "Synthetic result",
        occurredAt: stamp,
      },
      true,
    ),
    ReputationError,
  );
});
await test("all reads and writes carry abort; unauthorised and malformed pages remain errors", async () => {
  const abort = new AbortController();
  const seen: AbortSignal[] = [];
  const client = reputationClient(
    api((_method, _path, options) => {
      if (options?.signal) seen.push(options.signal);
      return Promise.resolve(response({ items: [], nextCursor: null }));
    }),
    abort.signal,
  );
  assert.deepEqual(await client.missions(), { items: [], nextCursor: null });
  assert.deepEqual(seen, [abort.signal]);
  await assert.rejects(
    reputationClient(
      api(() => Promise.resolve(response(null, 401))),
      abort.signal,
    ).summary("week"),
    (error: unknown) =>
      error instanceof ReputationError && error.status === 401,
  );
  await assert.rejects(
    reputationClient(
      api(() =>
        Promise.resolve(response({ items: [{ id: 3 }], nextCursor: null })),
      ),
      abort.signal,
    ).missions(),
    ReputationError,
  );
});
await test("reload recovery keeps opaque IDs isolated by actor and excludes report text", () => {
  const storage = memory();
  const first = recoveryStore("actor-a", storage);
  first.add({ kind: "report", requestId });
  assert.deepEqual(recoveryStore("actor-a", storage).list(), [
    { kind: "report", requestId },
  ]);
  assert.deepEqual(recoveryStore("actor-b", storage).list(), []);
  assert.deepEqual(recoveryStore(null, storage).list(), []);
  assert.equal(
    [...storage.values.values()].join("").includes("description"),
    false,
  );
  first.remove(requestId);
  assert.equal(storage.values.size, 0);
  storage.setItem("rada:reputation:pending:actor-a", "broken");
  assert.deepEqual(recoveryStore("actor-a", storage).list(), []);
});
await test("actor change while a command is in flight cannot repaint or remove its recovery ID", async () => {
  let finish: (value: ModuleResponse) => void = () => {};
  let active = true;
  let painted = 0;
  const client = reputationClient(
    api(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
    new AbortController().signal,
  );
  const storage = memory();
  const recovery = recoveryStore("actor-a", storage);
  const pending = new Map<string, Pending>([
    [mission.id, { body: { requestId, missionVersion: 1 }, attempted: false }],
  ]);
  const actions = commandActions(client, recovery, pending, {
    text: (key) => key,
    active: () => active,
    receipt: () => {
      painted++;
    },
    notice: () => {},
    error: () => "error",
    draw: () => {},
    reportRecovered: () => {},
    reportMissing: () => {},
    busy: new Set(),
  });
  const button = Button(mission.title);
  const work = actions.verify(mission, button);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "checking");
  active = false;
  finish(response(receipt));
  await work;
  assert.equal(painted, 0);
  assert.equal(recovery.list().length, 1);
  assert.deepEqual(recoveryStore("actor-b", storage).list(), []);
});

await test("overview reads a summary and page in one response", async () => {
  const calls: string[] = [];
  const client = reputationClient(
    api((_method, path) => {
      calls.push(path);
      return Promise.resolve(
        response({
          summary: baseSummary,
          page: { items: [], nextCursor: null },
        }),
      );
    }),
    new AbortController().signal,
  );
  const result = await client.overview("history", "week");
  assert.equal(result.summary.revision, "10");
  assert.deepEqual(result.data.items, []);
  assert.deepEqual(calls, ["/v1/reputation/overview?view=history&period=week"]);
});
await test("appeal reload recovery reads the exact receipt without another mutation", async () => {
  const storage = memory();
  const saved = recoveryStore("actor-a", storage);
  saved.add({ kind: "appeal", itemId: "synthetic-item", requestId });
  const calls: string[] = [];
  let accepted = 0;
  const client = reputationClient(
    api((method, path) => {
      calls.push(`${method} ${path}`);
      return Promise.resolve(
        response({
          appeal: {
            id: "synthetic-appeal",
            itemId: "synthetic-item",
            message: "Synthetic review",
            status: "open",
            resolution: null,
            createdAt: stamp,
          },
        }),
      );
    }),
    new AbortController().signal,
  );
  const actions = createAppealActions(
    {
      text: (key) => key,
      navigation: { push() {}, drop() {} } as never,
      signal: new AbortController().signal,
      error: () => "error",
      notice() {},
    },
    client,
    recoveryStore("actor-a", storage),
    new Map(),
    () => true,
    () => {
      accepted++;
    },
  );
  await actions.recover();
  assert.equal(accepted, 1);
  assert.deepEqual(calls, [`GET /v1/reputation/appeals/commands/${requestId}`]);
  assert.equal(recoveryStore("actor-a", storage).list().length, 0);
});
await test("authoritative missing report resumes its original ID; network failure keeps recovery pending", async () => {
  const saved = recoveryStore("actor-a", memory());
  saved.add({ kind: "report", requestId });
  let resumed = "";
  const client = reputationClient(
    api(() => Promise.resolve(response(null, 404))),
    new AbortController().signal,
  );
  const actions = commandActions(client, saved, new Map(), {
    text: (key) => key,
    active: () => true,
    receipt() {},
    notice() {},
    error: () => "error",
    draw() {},
    reportRecovered() {},
    reportMissing: (id) => {
      resumed = id;
    },
    busy: new Set(),
  });
  await actions.recoverCommands();
  assert.equal(resumed, requestId);
  assert.equal(saved.list().length, 1);
});

await test("unavailable command recovery never invents a report retry identity", async () => {
  const saved = recoveryStore("actor-a", memory());
  saved.add({ kind: "report", requestId });
  let resumed = false;
  const client = reputationClient(
    api(() => Promise.resolve(response(null, 503))),
    new AbortController().signal,
  );
  await commandActions(client, saved, new Map(), {
    text: (key) => key,
    active: () => true,
    receipt() {},
    notice() {},
    error: () => "error",
    draw() {},
    reportRecovered() {},
    reportMissing: () => {
      resumed = true;
    },
    busy: new Set(),
  }).recoverCommands();
  assert.equal(resumed, false);
  assert.equal(saved.list()[0]?.requestId, requestId);
});
