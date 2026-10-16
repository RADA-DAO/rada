import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";

const consentMethods = {
  ownFrogs: () => Promise.resolve([]),
  selectFrog: () => Promise.resolve(false),
  consents: () => Promise.resolve([]),
  setConsent: () => Promise.resolve(true),
};
const OPS = "synthetic-ops-token";

class DatabaseFailure extends Error {
  code = "57P01";
}

function build(
  me: () => never,
  lines: string[],
  token: string | undefined = OPS,
) {
  return createApp(
    FIXTURE_TOKEN,
    { ...consentMethods, me },
    [],
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    { token, log: (line) => lines.push(line) },
  );
}

Deno.test("request id is generated on success and on failure", async () => {
  const lines: string[] = [];
  const app = build(() => {
    throw new DatabaseFailure("boom");
  }, lines);
  const ok = await app.request("/health", {
    headers: { "request-id": "client-chosen" },
  });
  const okId = ok.headers.get("request-id");
  assert(ok.status === 200 && okId && okId !== "client-chosen");
  const failed = await app.request("/me", {
    headers: { authorization: `tma ${await signed()}` },
  });
  const failedId = failed.headers.get("request-id");
  assert(failed.status === 503 && failedId && failedId !== okId);
  assert((await failed.json()).error === "unavailable");
  assert(JSON.parse(lines[0]).requestId === failedId);
});

Deno.test(
  "failure record has route pattern, class, code and one line",
  async () => {
    const lines: string[] = [];
    const app = build(() => {
      throw new DatabaseFailure("boom");
    }, lines);
    await app.request("/me?subject_id=abc", {
      headers: { authorization: `tma ${await signed()}` },
    });
    assert(lines.length === 1);
    const record = JSON.parse(lines[0]);
    assert(record.route === "/me", `route ${record.route}`);
    assert(record.method === "GET");
    assert(record.errorClass === "DatabaseFailure");
    assert(record.errorCode === "57P01");
    assert(!Number.isNaN(Date.parse(record.time)));
    assert(typeof record.durationMs === "number" && record.durationMs >= 0);
    assert(!lines[0].includes("subject_id"));
    assert(
      Object.keys(record).sort().join() ===
        "durationMs,errorClass,errorCode,method,requestId,route,time",
    );
  },
);

Deno.test("failure record never contains secrets or error text", async () => {
  const lines: string[] = [];
  const initData = await signed();
  const secrets = [
    initData,
    "Bearer super-secret-token",
    "123456:ABC-bot-token-like",
    'duplicate key value violates unique constraint "users_pkey"',
    "postgres://svc:password@db.internal:5432/rada",
  ];
  const app = build(() => {
    const error = new Error(secrets.join(" | ")) as Error & {
      detail: string;
      code: string;
    };
    error.detail = secrets[3];
    error.code = secrets[1]; // not a safe code shape: must be dropped
    throw error;
  }, lines);
  await app.request("/me?token=123456:ABC-bot-token-like", {
    method: "GET",
    headers: {
      authorization: `tma ${initData}`,
      "x-forwarded-for": "203.0.113.9",
    },
  });
  assert(lines.length === 1);
  for (const secret of [...secrets, "203.0.113.9", "synthetic", "token="])
    assert(!lines[0].includes(secret), `leaked ${secret}`);
  assert(!("errorCode" in JSON.parse(lines[0])));
});

Deno.test(
  "/health/errors counts per route and requires the ops token",
  async () => {
    const lines: string[] = [];
    const app = build(() => {
      throw new DatabaseFailure("boom");
    }, lines);
    const auth = { authorization: `tma ${await signed()}` };
    await app.request("/me", { headers: auth });
    await app.request("/me", { headers: auth });
    for (const authorization of [
      undefined,
      "Bearer wrong",
      "Bearer ",
      OPS,
      `tma ${await signed()}`,
    ]) {
      const response = await app.request("/health/errors", {
        headers: authorization ? { authorization } : {},
      });
      assert(response.status === 404, `status ${response.status}`);
    }
    const allowed = await app.request("/health/errors", {
      headers: { authorization: `Bearer ${OPS}` },
    });
    assert(allowed.status === 200);
    const body = await allowed.json();
    assert(body.failures["/me"] === 2);
    const disabled = build(
      () => {
        throw new Error("unused");
      },
      [],
      undefined,
    );
    const none = await disabled.request("/health/errors", {
      headers: { authorization: "Bearer " },
    });
    assert(none.status === 404);
  },
);
