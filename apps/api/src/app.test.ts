import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
const consentMethods = {
  ownFrogs: () => Promise.resolve([]),
  selectFrog: () => Promise.resolve(false),
  consents: () => Promise.resolve([]),
  setConsent: (
    _id: string,
    _app: string,
    _capability: string,
    granted: boolean,
  ) => Promise.resolve(granted),
};
Deno.test("health, auth failures and self-only private response", async () => {
  let calls = 0;
  const app = createApp(FIXTURE_TOKEN, {
    ...consentMethods,
    me: (id) => {
      calls++;
      assert(id === "101");
      return Promise.resolve({
        subject_id: "00000000-0000-4000-8000-000000000001",
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      });
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
    const health = await app.request("/unknown", {
      headers: { origin: "https://miniapp.example" },
    });
    assert(
      health.headers.get("access-control-expose-headers") ===
        "Retry-After,ETag,Content-Location",
    );
  },
);
Deno.test(
  "membership uses verified identity and provider failure preserves private profile",
  async () => {
    const store = {
      ...consentMethods,
      me: () =>
        Promise.resolve({
          subject_id: "00000000-0000-4000-8000-000000000001",
          profile: { visibility: "private" as const, public: null },
          membership: { status: "unavailable" as const },
        }),
    };
    let called = false;
    const provider = {
      status: (id: string) => {
        called = true;
        assert(id === "101");
        return Promise.resolve("member" as const);
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
        me: () => {
          calls++;
          return Promise.resolve({
            subject_id: "fixture",
            profile: { visibility: "private", public: null },
            membership: { status: "unavailable" },
          });
        },
      },
      [],
      {
        status: () => {
          membershipCalls++;
          return Promise.resolve("member");
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
      ...consentMethods,
      me: () => {
        return Promise.reject(Error("unused"));
      },
      consents: (id) => {
        assert(id === "101");
        return Promise.resolve([
          { app_id: "example", capability: "wallet.address.read" },
        ]);
      },
      setConsent: (id, appId, capability, granted) => {
        writes.push(`${id}:${appId}:${capability}:${granted}`);
        return Promise.resolve(granted);
      },
    });
    const fresh = `tma ${await signed()}`;
    const read = await app.request("/me/consents", {
      headers: { authorization: fresh },
    });
    assert(read.status === 200 && (await read.json()).consents.length === 1);
    const put = (body: unknown, authorization = fresh) =>
      Promise.resolve(
        app.request("/me/consents", {
          method: "PUT",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
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

Deno.test(
  "profile collection and selection are self-only, bounded and privileged",
  async () => {
    const own = "00000000-0000-4000-8000-000000000011";
    const foreign = "00000000-0000-4000-8000-000000000012";
    const writes: (string | null)[] = [];
    const app = createApp(FIXTURE_TOKEN, {
      ...consentMethods,
      me: () => {
        return Promise.reject(Error("unused"));
      },
      ownFrogs: (id) => {
        assert(id === "101");
        return Promise.resolve([
          {
            frog_id: own,
            username: "Fixture",
            background_color: null,
            accent_color: null,
            artwork_path: null,
          },
        ]);
      },
      selectFrog: (id, frogId) => {
        assert(id === "101");
        writes.push(frogId);
        return Promise.resolve(frogId === null || frogId === own);
      },
    });
    const fresh = `tma ${await signed()}`;
    const old = `tma ${await signed({ auth_date: String(Math.floor(Date.now() / 1000) - 3700) })}`;
    assert((await app.request("/me/frogs")).status === 401);
    const read = await app.request("/me/frogs?subject_id=other", {
      headers: { authorization: old },
    });
    const frogs = (await read.json()).frogs;
    assert(
      read.status === 200 &&
        frogs.length === 1 &&
        Object.keys(frogs[0]).length === 5 &&
        frogs[0].frog_id === own,
    );
    const put = (body: unknown, authorization = fresh) =>
      app.request("/me/profile-frog", {
        method: "PUT",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      {},
      { frogId: 7 },
      { frogId: "invalid" },
      { frogId: own, subjectId: "other" },
      { frogId: [own] },
    ])
      assert((await put(body)).status === 400);
    assert((await put({ frogId: own }, old)).status === 401);
    assert(writes.length === 0);
    assert((await put({ frogId: foreign })).status === 409);
    assert((await put({ frogId: own })).status === 200);
    assert((await put({ frogId: null })).status === 200);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1100));
      },
      cancel() {
        cancelled = true;
      },
    });
    assert(
      (
        await app.request(
          new Request("http://localhost/me/profile-frog", {
            method: "PUT",
            headers: {
              authorization: fresh,
              "content-type": "application/json",
            },
            body,
          }),
        )
      ).status === 413 && cancelled,
    );
    assert(
      (
        await app.request("/me/profile-frog", {
          method: "PUT",
          headers: { authorization: fresh, "content-type": "application/json" },
          body: new Uint8Array([255]),
        })
      ).status === 400,
    );
    assert(Number(writes.length) === 3);
  },
);

Deno.test(
  "staging configuration rejects missing, malformed and conflicting modes",
  async () => {
    const { identityAuthPolicy } =
      await import("../../../modules/identity/index.ts");
    const valid = {
      STAGING_RUNTIME: "true",
      STAGING_AUTH_MODE: "allowlist",
      STAGING_ALLOWED_TELEGRAM_IDS: "101,102",
    };
    for (const config of [
      { STAGING_RUNTIME: "true" },
      { ...valid, STAGING_AUTH_MODE: "unknown" },
      { ...valid, STAGING_ALLOWED_TELEGRAM_IDS: undefined },
      { ...valid, STAGING_ALLOWED_TELEGRAM_IDS: "" },
      { ...valid, STAGING_ALLOWED_TELEGRAM_IDS: " " },
      ...["101,", "101,101", "001", "-101", "101.5", "9007199254740992"].map(
        (ids) => ({ ...valid, STAGING_ALLOWED_TELEGRAM_IDS: ids }),
      ),
      { ...valid, STAGING_SYNTHETIC_ONLY: "true" },
      { ...valid, STAGING_RUNTIME: "false" },
      {
        ...valid,
        STAGING_AUTH_MODE: "synthetic",
        STAGING_SYNTHETIC_ONLY: "true",
      },
      { ...valid, STAGING_SYNTHETIC_ONLY: "TRUE" },
    ]) {
      let rejected = false;
      try {
        identityAuthPolicy(config);
      } catch (error) {
        rejected = true;
        assert(!String(error).includes("101"));
      }
      assert(rejected);
    }
    assert(identityAuthPolicy({}).mode === "production");
  },
);

Deno.test(
  "allowlist guards all staging data routes before stores and providers",
  async () => {
    const { identityAuthPolicy } =
      await import("../../../modules/identity/index.ts");
    let dataCalls = 0;
    let providerCalls = 0;
    const policy = identityAuthPolicy({
      STAGING_RUNTIME: "true",
      STAGING_AUTH_MODE: "allowlist",
      STAGING_ALLOWED_TELEGRAM_IDS: "101,102",
    });
    const registry = {
      published: () => {
        dataCalls++;
        return Promise.resolve([]);
      },
      queue: () => {
        dataCalls++;
        return Promise.resolve([]);
      },
      reserveSubmissionAttempt: () => Promise.resolve(0),
      submit: () => {
        return Promise.reject(Error("unexpected"));
      },
      review: () => {
        return Promise.reject(Error("unexpected"));
      },
      publish: () => {
        return Promise.reject(Error("unexpected"));
      },
      rollback: () => {
        return Promise.reject(Error("unexpected"));
      },
      withdraw: () => {
        return Promise.reject(Error("unexpected"));
      },
      setTier: () => {
        return Promise.reject(Error("unexpected"));
      },
      tierChanges: () => {
        return Promise.reject(Error("unexpected"));
      },
    };
    const app = createApp(
      FIXTURE_TOKEN,
      {
        ...consentMethods,
        me: () => {
          dataCalls++;
          return Promise.resolve({
            subject_id: "fixture",
            profile: { visibility: "private", public: null },
            membership: { status: "unavailable" },
          });
        },
        consents: () => {
          dataCalls++;
          return Promise.resolve([]);
        },
        setConsent: () => {
          dataCalls++;
          return Promise.resolve(false);
        },
      },
      ["https://staging.example.invalid"],
      {
        status: () => {
          providerCalls++;
          return Promise.resolve("member");
        },
      },
      policy,
      registry,
      "https://artifacts.example",
    );
    for (const authorization of [
      "",
      "tma invalid",
      `tma ${await signed({ user: JSON.stringify({ id: 103 }) })}`,
      `tma ${await signed({}, "wrong-fixture-token")}`,
    ]) {
      for (const [path, method] of [
        ["/me", "GET"],
        ["/me/consents", "GET"],
        ["/me/consents", "PUT"],
        ["/apps/published", "GET"],
        ["/unknown-data-route", "GET"],
        ["/health", "POST"],
        ["/apps/review-queue", "GET"],
        ["/apps/example/versions", "POST"],
        ["/apps/example/withdraw", "POST"],
      ] as Array<[string, string]>)
        assert(
          (await app.request(path, { method, headers: { authorization } }))
            .status === 401,
        );
    }
    assert(dataCalls === 0 && providerCalls === 0);
    assert((await app.request("/health")).status === 200);
    assert(
      (
        await app.request("/apps/published", {
          method: "OPTIONS",
          headers: {
            origin: "https://staging.example.invalid",
            "access-control-request-method": "GET",
          },
        })
      ).status === 204,
    );
    for (const id of [101, 102]) {
      const headers = {
        authorization: `tma ${await signed({ user: JSON.stringify({ id }) })}`,
      };
      assert((await app.request("/me", { headers })).status === 200);
      assert(
        (await app.request("/apps/published", { headers })).status === 200,
      );
    }
    const old = {
      authorization: `tma ${await signed({ auth_date: String(Math.floor(Date.now() / 1000) - 3700) })}`,
    };
    assert((await app.request("/me", { headers: old })).status === 200);
    assert(
      (await app.request("/apps/review-queue", { headers: old })).status ===
        401,
    );
    assert(
      (await app.request("/me/consents", { method: "PUT", headers: old }))
        .status === 401,
    );
    assert(providerCalls === 0);
    const production = createApp(
      FIXTURE_TOKEN,
      {
        ...consentMethods,
        me: () => {
          return Promise.reject(Error("unused"));
        },
      },
      [],
      undefined,
      false,
      registry,
      "https://artifacts.example",
    );
    assert((await production.request("/apps/published")).status === 200);
  },
);
