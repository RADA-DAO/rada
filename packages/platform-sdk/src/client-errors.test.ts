import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReport,
  installClientErrors,
  reduceStack,
  DIAGNOSTIC_CODES,
} from "./client-errors.ts";

const origin = "https://app.example";
const ctx = { origin, build: "abc1234", route: "launcher" };

await test("reports map known error classes to fixed codes without message text", () => {
  const names = [
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "EvalError",
    "AggregateError",
    "AbortError",
    "TimeoutError",
  ];
  for (const [index, name] of names.entries()) {
    const error = new Error(
      '{"first_name":"Example Person","username":"example_person"}',
    );
    error.name = name;
    const report = buildReport("error", error, ctx);
    assert.equal(report.name, name);
    assert.equal(report.message, DIAGNOSTIC_CODES[index + 1]);
  }
  for (const thrown of [
    new Error("Example Person"),
    "example_person",
    { message: "Example Person" },
    null,
  ]) {
    assert.equal(buildReport("error", thrown, ctx).message, "unknown");
  }
  const custom = new Error("type_error");
  custom.name = "CustomError";
  assert.equal(buildReport("error", custom, ctx).message, "unknown");
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
    message: "type_error",
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
  assert.equal(odd.message, "unknown");
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
  for (let i = 0; i < 30; i++) {
    const error = new Error("same message");
    error.stack = `Error\n at https://app.example/main.js:${String(i + 1)}:1`;
    fire("error", { error });
  }
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
