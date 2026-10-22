import { createHash } from "node:crypto";
import { createApp } from "./app.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
import { encodePng } from "../../../modules/splash/png.ts";
import type { IdentityStore } from "../../../modules/identity/index.ts";
const frog_id = "10000000-0000-4000-8000-000000000001";
const bytes = encodePng({
  width: 1,
  height: 1,
  rgba: new Uint8Array([1, 2, 3, 255]),
});
const sha256 = createHash("sha256").update(bytes).digest("hex");
const url = `/v1/frogs/${frog_id}/artwork/${sha256}`;
const frog = {
  frog_id,
  username: "Fixture",
  background_color: null,
  accent_color: null,
};
const identity: IdentityStore = {
  me: () =>
    Promise.resolve({
      subject_id: "self",
      profile: { visibility: "public", public: frog },
      membership: { status: "unavailable" },
    }),
  ownFrogs: () => Promise.resolve([{ ...frog, artwork_path: null }]),
  selectFrog: () => Promise.resolve(false),
  consents: () => Promise.resolve([]),
  setConsent: () => Promise.resolve(false),
};
function build(staging = false) {
  let reads = 0;
  const app = createApp(
    FIXTURE_TOKEN,
    identity,
    ["https://app.example"],
    undefined,
    staging,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    {
      page: () =>
        Promise.resolve({
          revision: "a".repeat(32),
          entries: [
            {
              rank: 1,
              frogId: frog_id,
              frogName: "Fixture",
              amount: "1",
              asOf: "2026-01-01",
              stale: false,
            },
          ],
        }),
    },
    undefined,
    {
      image: () => {
        reads++;
        return Promise.resolve({
          bytes,
          sha256,
          contentType: "image/png",
          needsNormalization: false,
          isPublic: true,
        });
      },
      references: () => {
        reads++;
        return Promise.resolve([{ frog_id, sha256 }]);
      },
    },
  );
  return { app, reads: () => reads };
}
Deno.test(
  "artwork composition preserves CORS, request ids and staging authentication",
  async () => {
    const { app } = build();
    const publicRead = await app.request(url, {
      headers: { Origin: "https://app.example" },
    });
    assert(publicRead.status === 200);
    assert(
      publicRead.headers.get("Access-Control-Allow-Origin") ===
        "https://app.example",
    );
    assert(publicRead.headers.has("request-id"));
    const preflight = await app.request(url, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example",
        "Access-Control-Request-Method": "HEAD",
      },
    });
    assert(
      preflight.headers.get("Access-Control-Allow-Methods")?.includes("HEAD"),
    );
    const staging = build(true);
    for (const method of ["GET", "HEAD"])
      assert((await staging.app.request(url, { method })).status === 401);
    assert(staging.reads() === 0);
    const response = await staging.app.request(url, {
      headers: { Authorization: `tma ${await signed()}` },
    });
    assert(
      response.status === 200 &&
        response.headers.get("Cache-Control") === "no-store",
    );
  },
);
Deno.test(
  "profile, collection and ranking projections gain only artwork URLs",
  async () => {
    const { app } = build();
    const headers = { Authorization: `tma ${await signed()}` };
    for (const path of ["/me", "/me/frogs", "/v1/rankings/holders?token=TON"]) {
      const response = await app.request(path, { headers });
      const body = await response.json();
      assert(
        response.status === 200 &&
          response.headers.get("Cache-Control") === "no-store",
      );
      const projected =
        path === "/me"
          ? body.profile.public
          : path === "/me/frogs"
            ? body.frogs[0]
            : body.entries[0];
      assert((projected.artwork_url ?? projected.artworkUrl) === url);
      assert(!("subject_id" in projected) && !("bytes" in projected));
    }
  },
);

Deno.test(
  "nested SPLASH projections retain hidden profiles and missing artwork",
  async () => {
    const { Hono } = await import("hono");
    const { registerArtworkProjections } =
      await import("./artwork-projections.ts");
    const app = new Hono();
    registerArtworkProjections(
      app,
      {
        image: () => Promise.resolve(null),
        references: (ids, viewer) => {
          assert(viewer === null && ids.length === 2);
          return Promise.resolve([{ frog_id, sha256 }]);
        },
      },
      () => Promise.resolve(null),
    );
    app.get("/v1/splash/pond", (c) =>
      c.json({
        frogs: [
          { author: frog, bidder_count: 12 },
          {
            author: {
              ...frog,
              frog_id: "20000000-0000-4000-8000-000000000002",
            },
          },
        ],
      }),
    );
    const body = await (await app.request("/v1/splash/pond")).json();
    assert(body.frogs[0].author.artwork_url === url);
    assert(body.frogs[0].bidder_count === 12);
    assert(body.frogs[1].author.artwork_url === null);
  },
);
