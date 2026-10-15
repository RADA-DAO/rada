import { assert, FIXTURE_TOKEN } from "./fixtures.ts";
import {
  TelegramMembershipProvider,
  MEMBERSHIP_CACHE_TTL_MS,
  MEMBERSHIP_CACHE_MAX_SIZE,
} from "../../../modules/identity/index.ts";
function reply(status: string, extra = {}) {
  return Response.json({
    ok: true,
    result: { status, user: { id: 101 }, ...extra },
  });
}
Deno.test(
  "Telegram membership canonical statuses and malformed results",
  async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["creator", {}, "member"],
      ["administrator", {}, "member"],
      ["member", {}, "member"],
      ["restricted", { is_member: true }, "member"],
      ["restricted", { is_member: false }, "not_member"],
      ["left", {}, "not_member"],
      ["kicked", {}, "not_member"],
      ["restricted", {}, "unavailable"],
      ["restricted", { is_member: "true" }, "unavailable"],
      ["unknown", {}, "unavailable"],
      ["member", { user: { id: 102 } }, "unavailable"],
      ["member", { user: { id: "101" } }, "unavailable"],
    ];
    for (const [status, extra, expected] of cases) {
      const provider = new TelegramMembershipProvider(FIXTURE_TOKEN, "-101", {
        fetch: (url, options) => {
          assert(
            String(url) ===
              `https://api.telegram.org/bot${FIXTURE_TOKEN}/getChatMember`,
          );
          assert(options?.method === "POST" && options.redirect === "error");
          const body = JSON.parse(String(options.body));
          assert(body.chat_id === "-101" && body.user_id === 101);
          return Promise.resolve(reply(status, extra));
        },
      });
      assert((await provider.status("101")) === expected);
    }
  },
);
Deno.test(
  "short cache expires at boundary and is isolated by provider bot and chat",
  async () => {
    let now = 0;
    let calls = 0;
    let status = "member";
    const dependencies = {
      now: () => now,
      fetch: () => {
        calls++;
        return Promise.resolve(reply(status));
      },
    };
    const provider = new TelegramMembershipProvider(
      FIXTURE_TOKEN,
      "-101",
      dependencies,
    );
    assert((await provider.status("101")) === "member");
    status = "left";
    now = MEMBERSHIP_CACHE_TTL_MS - 1;
    assert((await provider.status("101")) === "member" && calls === 1);
    now++;
    assert(
      (await provider.status("101")) === "not_member" && Number(calls) === 2,
    );
    for (const [token, chat] of [
      [FIXTURE_TOKEN, "-102"],
      ["other-synthetic-token", "-101"],
      [FIXTURE_TOKEN, "-101"],
    ] as Array<[string, string]>) {
      assert(
        (await new TelegramMembershipProvider(token, chat, dependencies).status(
          "101",
        )) === "not_member",
      );
    }
    assert(Number(calls) === 5);
  },
);
Deno.test("bounded cache evicts oldest identity", async () => {
  let calls = 0;
  const provider = new TelegramMembershipProvider(FIXTURE_TOKEN, "-101", {
    fetch: (_url, options) => {
      calls++;
      const { user_id } = JSON.parse(String(options?.body));
      return Promise.resolve(reply("member", { user: { id: user_id } }));
    },
  });
  for (let id = 1; id <= MEMBERSHIP_CACHE_MAX_SIZE + 1; id++)
    assert((await provider.status(String(id))) === "member");
  await provider.status("1");
  assert(calls === MEMBERSHIP_CACHE_MAX_SIZE + 2);
});
Deno.test(
  "errors, malformed JSON and timeout fail closed without caching unavailable",
  async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.resolve(new Response("failure", { status: 429 })),
      () =>
        Promise.resolve(Response.json({ ok: false, description: "sensitive" })),
      () => Promise.resolve(Response.json(null)),
      () => Promise.resolve(new Response("{malformed")),
      () => {
        return Promise.reject(new Error("sensitive token URL"));
      },
    ];
    for (const failure of failures) {
      let calls = 0;
      const provider = new TelegramMembershipProvider(FIXTURE_TOKEN, "-101", {
        fetch: () => {
          calls++;
          return Promise.resolve(calls === 1 ? failure() : reply("member"));
        },
      });
      assert((await provider.status("101")) === "unavailable");
      assert((await provider.status("101")) === "member" && calls === 2);
    }
    let aborted = false;
    const timeout = new TelegramMembershipProvider(FIXTURE_TOKEN, "-101", {
      timeoutMs: 1,
      fetch: (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("synthetic timeout"));
          });
        }),
    });
    assert((await timeout.status("101")) === "unavailable" && aborted);
  },
);

Deno.test(
  "expired member is unavailable during outage, never stale",
  async () => {
    let now = 0;
    let outage = false;
    const provider = new TelegramMembershipProvider(FIXTURE_TOKEN, "-101", {
      now: () => now,
      fetch: () =>
        Promise.resolve(
          outage
            ? new Response("unavailable", { status: 503 })
            : reply("member"),
        ),
    });
    assert((await provider.status("101")) === "member");
    now = MEMBERSHIP_CACHE_TTL_MS;
    outage = true;
    assert((await provider.status("101")) === "unavailable");
    outage = false;
    assert((await provider.status("101")) === "member");
  },
);
