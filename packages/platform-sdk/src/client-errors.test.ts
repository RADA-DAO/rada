import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReport,
  installClientErrors,
  reduceStack,
  sanitizeMessage,
} from "./client-errors.ts";

const origin = "https://app.example";
const ctx = { origin, build: "abc1234", route: "launcher" };

await test("message: digits, hex, addresses, emails and URLs are removed", () => {
  assert.equal(sanitizeMessage("balance 12345 failed"), "balance # failed");
  assert.equal(
    sanitizeMessage("tx 0xdeadbeefcafe and cafebabe1234"),
    "tx <hex> and <hex>",
  );
  assert.equal(
    sanitizeMessage(
      "wallet UQDrjaLahLkMB-hMCmkzOyBuHbJ0hjHSy4Gw9AkX9Hn6sQVL bad",
    ),
    "wallet <addr> bad",
  );
  assert.equal(
    sanitizeMessage(`raw 0:${"ab".repeat(32)} bad`),
    "raw <addr> bad",
  );
  assert.equal(sanitizeMessage("mail a.b@example.com now"), "mail <email> now");
  assert.equal(
    sanitizeMessage("GET https://x.example/p?token=abc failed"),
    "GET <url> failed",
  );
  assert.equal(sanitizeMessage("a\u0000b\n\nc"), "a b c");
});

await test("message: capped at 120 chars and idempotent", () => {
  const long = sanitizeMessage("word ".repeat(100));
  assert.equal(long.length, 120);
  const once = sanitizeMessage("id 42 a@b.co https://x.y/z");
  assert.equal(sanitizeMessage(once), once);
});

await test("stack: own-origin frames only, as file:line:col without query", () => {
  const stack = [
    "TypeError: x",
    "    at run (https://app.example/assets/index-Ab12.js?v=3:10:20)",
    "    at https://evil.example/assets/other.js:1:1",
    "    at https://app.example/assets/chunk.js:7:8",
    "run@https://app.example/assets/ff.js:5:6",
    "    at <anonymous>",
  ].join("\n");
  assert.deepEqual(reduceStack(stack, origin), [
    "index-Ab12.js:10:20",
    "chunk.js:7:8",
    "ff.js:5:6",
  ]);
});

await test("report: carries only the contract fields", () => {
  const error = new TypeError("bad 99 value");
  error.stack = "TypeError\n at f (https://app.example/a.js:1:2)";
  assert.deepEqual(buildReport("error", error, ctx), {
    kind: "error",
    name: "TypeError",
    message: "bad # value",
    frames: ["a.js:1:2"],
    build: "abc1234",
    route: "launcher",
  });
  const odd = buildReport(
    "unhandledrejection",
    { secret: "x" },
    {
      ...ctx,
      route: "Bad Route 123",
    },
  );
  assert.equal(odd.name, "NonError");
  assert.equal(odd.message, "");
  assert.equal(odd.route, "other");
  assert.equal(
    buildReport("error", new Error("x"), { ...ctx, build: "has space" }).build,
    "dev",
  );
});

function harness(route = () => "launcher") {
  const listeners = new Map<string, (event: Event) => void>();
  const sent: string[] = [];
  const dispose = installClientErrors({
    endpoint: "/api/v1/client-errors",
    route,
    build: "abc1234",
    origin,
    target: {
      addEventListener: (name: string, fn: unknown) =>
        void listeners.set(name, fn as (event: Event) => void),
      removeEventListener: (name: string) => void listeners.delete(name),
    } as never,
    send: (_endpoint, body) => void sent.push(body),
  });
  const fire = (name: string, init: object) =>
    listeners.get(name)?.(init as Event);
  return { sent, fire, dispose, listeners };
}

await test("listeners report errors and rejections, dedupe identical ones", () => {
  const { sent, fire } = harness();
  fire("error", { error: new Error("boom 1") });
  fire("error", { error: new Error("boom 2") });
  assert.equal(sent.length, 1);
  fire("unhandledrejection", { reason: new Error("boom 1") });
  fire("error", { message: "Script error." });
  assert.equal(sent.length, 3);
  assert.equal(
    (JSON.parse(sent[1] ?? "") as { kind: string }).kind,
    "unhandledrejection",
  );
});

await test("at most 10 reports per page session", () => {
  const { sent, fire } = harness();
  for (let i = 0; i < 30; i++)
    fire("error", { error: new Error(`distinct${"x".repeat(i)}`) });
  assert.equal(sent.length, 10);
});

await test("a failing route reader or sender never throws; dispose detaches", () => {
  const { fire, sent, dispose, listeners } = harness(() => {
    throw new Error("route");
  });
  assert.doesNotThrow(() => fire("error", { error: new Error("x") }));
  assert.equal(sent.length, 0);
  dispose();
  assert.equal(listeners.size, 0);
});
