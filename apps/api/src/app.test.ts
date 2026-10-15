import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
Deno.test("health, auth failures and self-only private response", async () => {
  let calls = 0;
  const app = createApp(FIXTURE_TOKEN, {
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
  "staging rejects non-fixture identities before persistence",
  async () => {
    let calls = 0;
    const app = createApp(
      FIXTURE_TOKEN,
      {
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
      true,
    );
    for (const id of [101, 102, 103]) {
      const response = await app.request("/me", {
        headers: {
          authorization: `tma ${await signed({ user: JSON.stringify({ id }) })}`,
        },
      });
      assert(response.status === (id === 103 ? 401 : 200));
    }
    assert(calls === 2);
  },
);
