import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fake,
  fakeDocument,
  FakeElement,
} from "../../../packages/ui/scripts/fake-dom.ts";
import { Button, Group, Screen } from "../../../packages/ui/src/index.ts";
import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
import { reputationClient } from "./client.ts";
import { subscribeChanges } from "./updates.ts";
import { historyView, itemView, replaceContent, taskView } from "./views.ts";
import { share, shareText } from "./share.ts";
import { receiptIsCurrent } from "./model.ts";
import type { ReputationItem, Summary } from "../contract.ts";
Object.defineProperty(globalThis, "HTMLButtonElement", {
  configurable: true,
  value: FakeElement,
});
const ctx = {
  locale: "en" as const,
  text: (key: string) => key,
  points: (value: string) => `${value} REP`,
};
await test("tasks and history expose useful empty states and four period actions", () => {
  const tasks = Group(
    taskView(ctx, [], Button(ctx.text("report.open")), {
      busy: new Set(),
      retry: () => false,
      verify: () => {},
    }),
  );
  assert.match(tasks.textContent, /empty.tasksHint/);
  let period = "today";
  const history = Group(
    historyView(
      ctx,
      [],
      "today",
      (next) => {
        period = next;
      },
      () => {},
    ),
  );
  assert.match(history.textContent, /empty.historyHint/);
  assert.equal(fake(history).all("rada-tabs")[0]?.children.length, 4);
  fake(history).all("rada-button")[2]?.click();
  assert.equal(period, "previous_week");
});
await test("detail keeps evidence and appeals accessible without raw rule hash or unsafe links", () => {
  const item: ReputationItem = {
    id: "synthetic",
    title: "Synthetic",
    category: "participation",
    points: "1",
    status: "accepted",
    reason: "signed_acknowledgement",
    occurredAt: "2026-11-13T12:00:00Z",
    recordedAt: "2026-11-13T12:00:00Z",
    ruleHash: "opaque-rule",
    evidence: [
      { id: "e", url: "javascript:alert(1)", label: "Synthetic evidence" },
    ],
    missionId: null,
  };
  const host = Group(itemView(ctx, item, [], Button(ctx.text("appeal.open"))));
  assert.match(host.textContent, /reason.signed_acknowledgement/);
  assert.equal(host.textContent.includes("opaque-rule"), false);
  assert.equal(fake(host).querySelectorAll("a").length, 0);
  assert.match(host.textContent, /Synthetic evidence/);
  assert.match(host.textContent, /appeal.empty/);
});
await test("refresh restores the same focused item and completed task falls back to heading", () => {
  const before = Button(ctx.text("before"));
  before.dataset.focusKey = "item:synthetic";
  const target = Group([before]);
  const screen = Screen({ title: ctx.text("title"), children: [target] });
  fakeDocument.body.append(fake(screen));
  before.focus();
  const after = Button(ctx.text("after"));
  after.dataset.focusKey = "item:synthetic";
  replaceContent(target, [after], screen);
  assert.equal(fakeDocument.activeElement, fake(after));
  const completed = Button(ctx.text("completed"), { disabled: true });
  completed.dataset.focusKey = "item:synthetic";
  replaceContent(target, [completed], screen);
  assert.equal(fakeDocument.activeElement.tagName, "h1");
});
await test("frozen yesterday receipt cannot repaint today's zero at the same revision", () => {
  const value = {
    period: "today",
    start: "2026-11-12T22:00:00Z",
    end: "2026-11-13T12:00:00Z",
    revision: "10",
  } as Summary;
  assert.equal(
    receiptIsCurrent(value, value, Date.parse("2026-11-13T13:00:00Z")),
    true,
  );
  assert.equal(
    receiptIsCurrent(
      value,
      { ...value, start: "2026-11-13T22:00:00Z" },
      Date.parse("2026-11-14T13:00:00Z"),
    ),
    false,
  );
});
await test("stream reset adopts lower durable cursor; late events after disposal cannot refresh", async () => {
  const abort = new AbortController();
  const reads: string[] = [];
  let painted = 0;
  let streamPath = "";
  let emit:
    | ((event: { event: string; data: unknown; id: string | null }) => void)
    | undefined;
  const api: ModuleApi & {
    stream(
      path: string,
      options: { signal?: AbortSignal; onEvent: NonNullable<typeof emit> },
    ): Promise<void>;
  } = {
    url: (path) => path,
    request: (_method, path) => {
      reads.push(path);
      return Promise.resolve({
        status: 200,
        body: {
          version: 1,
          changes: [],
          nextCursor: "2",
          resetRequired: true,
          hasMore: false,
        },
        retryAfter: null,
      });
    },
    stream: (path, options) => {
      streamPath = path;
      emit = (event) => {
        options.onEvent(event);
      };
      return new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      });
    },
  };
  subscribeChanges(
    api,
    reputationClient(api, abort.signal),
    "100",
    abort.signal,
    () => {
      painted++;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reads, ["/v1/reputation/changes?after=100"]);
  assert.equal(streamPath, "/v1/reputation/stream?after=2");
  assert.equal(painted, 1);
  abort.abort();
  emit?.({
    event: "changes",
    id: "3",
    data: {
      version: 1,
      changes: [],
      nextCursor: "3",
      resetRequired: true,
      hasMore: false,
    },
  });
  assert.equal(painted, 1);
});

await test("sharing uses exact summary points and supports native, clipboard and cancellation", async () => {
  let native = "";
  let copied = "";
  const message = shareText(
    (key, values) => (key === "share.text" ? JSON.stringify(values) : key),
    { period: "week", totalPoints: "12.5001", pendingCount: 2 } as Summary,
  );
  assert.deepEqual(JSON.parse(message), {
    period: "period.week",
    points: "12.5001",
    pending: 2,
  });
  assert.equal(
    await share(message, {
      share: (data) => {
        native = data.text;
        return Promise.resolve();
      },
    }),
    "shared",
  );
  assert.equal(native, message);
  assert.equal(
    await share(message, {
      clipboard: {
        writeText: (value) => {
          copied = value;
          return Promise.resolve();
        },
      },
    }),
    "copied",
  );
  assert.equal(copied, message);
  assert.equal(
    await share(message, {
      share: () => Promise.reject(new DOMException("cancelled", "AbortError")),
    }),
    "cancelled",
  );
  await assert.rejects(share(message, {}));
});
