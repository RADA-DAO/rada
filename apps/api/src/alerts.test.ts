import {
  FailureDigest,
  alertConfig,
  formatDigest,
  type AlertStore,
} from "../../../modules/ops/index.ts";
import { assert } from "./fixtures.ts";

const config = { token: "123:SECRET", chatId: "-100123" };

function fakeStore(rows: { label: string; total: number }[], lastId = 7) {
  const calls = { summary: 0, advanced: [] as number[] };
  const total = rows.reduce((n, r) => n + r.total, 0);
  const store: AlertStore = {
    summary: () => {
      calls.summary++;
      return Promise.resolve({ groups: rows, total, lastId });
    },
    advance: (id) => {
      calls.advanced.push(id);
      return Promise.resolve();
    },
  };
  return { store, calls };
}

Deno.test("alert config requires explicit enable, chat id and token", () => {
  const base = {
    ALERTS_ENABLED: "true",
    ALERT_TELEGRAM_CHAT_ID: "-100123",
    TELEGRAM_BOT_TOKEN: "t",
  };
  assert(alertConfig(base)?.chatId === "-100123");
  assert(alertConfig({ ...base, ALERTS_ENABLED: "false" }) === undefined);
  assert(alertConfig({ ...base, ALERTS_ENABLED: undefined }) === undefined);
  assert(alertConfig({ ...base, ALERT_TELEGRAM_CHAT_ID: "" }) === undefined);
  assert(alertConfig({ ...base, ALERT_TELEGRAM_CHAT_ID: "a b" }) === undefined);
  assert(alertConfig({ ...base, TELEGRAM_BOT_TOKEN: "" }) === undefined);
});

Deno.test("digest keeps top 3 groups and drops unsafe characters", () => {
  const text = formatDigest(
    {
      total: 10,
      groups: [
        { label: "error/TypeError/home", total: 1 },
        { label: "error/A/wallet", total: 5 },
        { label: "error/B/wallet", total: 2 },
        { label: "error/C/wallet", total: 1 },
        { label: "ann@example.com 123456789", total: 1 },
      ],
    },
    { total: 2, groups: [{ label: "/v1/me", total: 2 }] },
  );
  assert(text !== undefined);
  assert(text.includes("Client errors: 10"));
  assert(text.includes("5 x error/A/wallet"));
  assert(text.includes("(+2 more groups)"));
  assert(!text.includes("error/C/wallet"));
  assert(text.includes("Server failures: 2"));
  assert(!text.includes("@"));
  assert(
    formatDigest({ total: 0, groups: [] }, { total: 0, groups: [] }) ===
      undefined,
  );
  const odd = formatDigest(
    { total: 1, groups: [{ label: "a@b.example 42", total: 1 }] },
    { total: 0, groups: [] },
  );
  assert(odd !== undefined && !odd.includes("@") && !odd.includes(" 42"));
});

Deno.test("zero failures send nothing", async () => {
  let fetches = 0;
  const { store, calls } = fakeStore([]);
  const digest = new FailureDigest({
    config,
    store,
    counts: new Map(),
    fetch: () => {
      fetches++;
      return Promise.resolve(new Response("{}"));
    },
  });
  assert((await digest.run()) === false);
  assert(fetches === 0 && calls.advanced.length === 0);
});

Deno.test("sends once, advances watermark and server baseline", async () => {
  const bodies: string[] = [];
  const urls: string[] = [];
  const counts = new Map([["/v1/me", 3]]);
  const { store, calls } = fakeStore([{ label: "error/E/home", total: 2 }], 9);
  const digest = new FailureDigest({
    config,
    store,
    counts,
    fetch: (url, init) => {
      urls.push(url);
      bodies.push(String(init?.body));
      return Promise.resolve(new Response("{}"));
    },
  });
  assert((await digest.run()) === true);
  assert(urls[0] === "https://api.telegram.org/bot123:SECRET/sendMessage");
  const sent = JSON.parse(bodies[0] ?? "{}");
  assert(sent.chat_id === "-100123" && sent.text.includes("3 x /v1/me"));
  assert(calls.advanced.length === 1 && calls.advanced[0] === 9);
  counts.set("/v1/me", 5);
  const urlsBefore = urls.length;
  assert((await digest.run()) === true && urls.length === urlsBefore + 1);
  assert(JSON.parse(bodies[1] ?? "{}").text.includes("Server failures: 2"));
});

Deno.test(
  "failed send logs one sanitized line and retries without losing data",
  async () => {
    const lines: string[] = [];
    let ok = false;
    const { store, calls } = fakeStore(
      [{ label: "error/E/home", total: 1 }],
      4,
    );
    const digest = new FailureDigest({
      config,
      store,
      counts: new Map(),
      log: (line) => lines.push(line),
      fetch: () =>
        ok
          ? Promise.resolve(new Response("{}"))
          : Promise.reject(
              new TypeError("https://api.telegram.org/bot123:SECRET/x"),
            ),
    });
    assert((await digest.run()) === false);
    assert(lines.length === 1 && !lines[0]?.includes("SECRET"));
    assert(JSON.parse(lines[0] ?? "{}").errorClass === "TypeError");
    assert(calls.advanced.length === 0);
    ok = true;
    assert((await digest.run()) === true);
    assert(calls.advanced[0] === 4);
    // HTTP failure reports status only.
    const http = new FailureDigest({
      config,
      store,
      counts: new Map(),
      log: (line) => lines.push(line),
      fetch: () => Promise.resolve(new Response("denied", { status: 403 })),
    });
    assert((await http.run()) === false);
    assert(JSON.parse(lines[1] ?? "{}").status === 403);
  },
);

Deno.test("a failing store never throws out of run", async () => {
  const digest = new FailureDigest({
    config,
    store: {
      summary: () => Promise.reject(new Error("db down")),
      advance: () => Promise.resolve(),
    },
    counts: new Map(),
    log: () => {
      throw new Error("log broken");
    },
    fetch: () => Promise.reject(new Error("unused")),
  });
  assert((await digest.run()) === false);
});
