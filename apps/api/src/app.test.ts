import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
const consentMethods = {
  consents: async () => [],
  setConsent: async (
    _id: string,
    _app: string,
    _capability: string,
    granted: boolean,
  ) => granted,
};
Deno.test("health, auth failures and self-only private response", async () => {
  let calls = 0;
  const app = createApp(FIXTURE_TOKEN, {
    ...consentMethods,
    me: async (id) => {
      calls++;
      assert(id === "101");
      return {
        subject_id: "00000000-0000-4000-8000-000000000001",
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      };
    },
  });
  assert((await app.request("/health")).status === 200);
  for (const authorization of ["", "Bearer fake", "tma invalid"])
    assert(
      (await app.request("/me", { headers: { authorization } })).status === 401,
    );
  assert(calls === 0);
  const response = await app.request("/me?subject_id=other", {
    headers: { authorization: `tma ${await signed()}` },
  });
  const body = await response.json();
  assert(
    response.status === 200 &&
      response.headers.get("cache-control") === "no-store",
  );
  assert(
    body.profile.visibility === "private" &&
      body.profile.public === null &&
      body.membership.status === "unavailable",
  );
  assert(!JSON.stringify(body).includes("synthetic"));
  const broken = createApp(FIXTURE_TOKEN, {
    ...consentMethods,
    me: () => {
      throw new Error("sensitive error");
    },
  });
  const failure = await broken.request("/me", {
    headers: { authorization: `tma ${await signed()}` },
  });
  assert(
    failure.status === 503 && !(await failure.text()).includes("sensitive"),
  );
});
Deno.test(
  "CORS permits only configured origins and authorization preflight",
  async () => {
    const app = createApp(
      FIXTURE_TOKEN,
      {
        ...consentMethods,
        me: () => {
          throw new Error("Unused");
        },
      },
      ["https://miniapp.example"],
    );
    for (const origin of [
      "https://miniapp.example",
      "https://untrusted.example",
    ]) {
      const response = await app.request("/me", {
        method: "OPTIONS",
        headers: {
          origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization",
        },
      });
      assert(
        response.headers.get("access-control-allow-origin") ===
          (origin === "https://miniapp.example" ? origin : null),
      );
      assert(!response.headers.has("access-control-allow-credentials"));
    }
  },
);
Deno.test(
  "membership uses verified identity and provider failure preserves private profile",
  async () => {
    const store = {
      ...consentMethods,
      me: async () => ({
        subject_id: "00000000-0000-4000-8000-000000000001",
        profile: { visibility: "private" as const, public: null },
        membership: { status: "unavailable" as const },
      }),
    };
    let called = false;
    const provider = {
      status: async (id: string) => {
        called = true;
        assert(id === "101");
        return "member" as const;
      },
    };
    const app = createApp(FIXTURE_TOKEN, store, [], provider);
    assert((await app.request("/me?user_id=102")).status === 401 && !called);
    const response = await app.request("/me?user_id=102&chat_id=-102", {
      headers: { authorization: `tma ${await signed()}` },
    });
    const body = await response.json();
    assert(
      body.membership.status === "member" &&
        body.profile.visibility === "private" &&
        body.profile.public === null,
    );
    const broken = createApp(FIXTURE_TOKEN, store, [], {
      status: () => {
        throw new Error("sensitive provider error");
      },
    });
    const unavailable = await broken.request("/me", {
      headers: { authorization: `tma ${await signed()}` },
    });
    const own = await unavailable.json();
    assert(
      unavailable.status === 200 &&
        own.membership.status === "unavailable" &&
        own.subject_id === body.subject_id &&
        own.profile.visibility === "private",
    );
  },
);

Deno.test(
  "staging rejects non-fixture identities before persistence",
  async () => {
    let calls = 0;
    let membershipCalls = 0;
    const app = createApp(
      FIXTURE_TOKEN,
      {
        ...consentMethods,
        me: async () => {
          calls++;
          return {
            subject_id: "fixture",
            profile: { visibility: "private", public: null },
            membership: { status: "unavailable" },
          };
        },
      },
      [],
      {
        status: async () => {
          membershipCalls++;
          return "member";
        },
      },
      true,
    );
    for (const id of [101, 102, 103]) {
      const response = await app.request("/me", {
        headers: {
          authorization: `tma ${await signed({ user: JSON.stringify({ id }) })}`,
        },
      });
      assert(response.status === (id === 103 ? 401 : 200));
      if (id !== 103)
        assert((await response.json()).membership.status === "unavailable");
    }
    assert(calls === 2 && membershipCalls === 0);
  },
);

Deno.test(
  "consent API validates shape and privileged age before self write",
  async () => {
    const writes: string[] = [];
    const app = createApp(FIXTURE_TOKEN, {
      me: async () => {
        throw Error("unused");
      },
      consents: async (id) => {
        assert(id === "101");
        return [{ app_id: "example", capability: "wallet.address.read" }];
      },
      setConsent: async (id, appId, capability, granted) => {
        writes.push(`${id}:${appId}:${capability}:${granted}`);
        return granted;
      },
    });
    const fresh = `tma ${await signed()}`;
    const read = await app.request("/me/consents", {
      headers: { authorization: fresh },
    });
    assert(read.status === 200 && (await read.json()).consents.length === 1);
    const put = async (body: unknown, authorization = fresh) =>
      app.request("/me/consents", {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      { appId: "example", capability: ["wallet.address.read"], granted: true },
      { appId: "example", capability: "money.transfer", granted: true },
      { appId: "example", capability: "wallet.address.read", granted: "true" },
      {
        appId: "example",
        capability: "wallet.address.read",
        granted: true,
        subjectId: "other",
      },
    ])
      assert((await put(body)).status === 400);
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(700));
      },
      cancel() {
        cancelled = true;
      },
    });
    const oversizedResponse = await app.request(
      new Request("http://localhost/me/consents", {
        method: "PUT",
        headers: { authorization: fresh, "content-type": "application/json" },
        body: oversized,
      }),
    );
    assert(
      oversizedResponse.status === 413 && cancelled && writes.join("") === "",
    );
    assert(
      (
        await put(
          {
            appId: "example",
            capability: "wallet.address.read",
            granted: true,
          },
          `tma ${await signed({ auth_date: String(Math.floor(Date.now() / 1000) - 3700) })}`,
        )
      ).status === 401,
    );
    assert(
      (
        await put({
          appId: "example",
          capability: "wallet.address.read",
          granted: true,
        })
      ).status === 200,
    );
    assert(
      writes.length === 1 &&
        writes[0] === "101:example:wallet.address.read:true",
    );
  },
);
