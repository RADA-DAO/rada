import { createApp } from "./app.ts";
import type {
  OwnSubmission,
  SplashStore,
} from "../../../modules/splash/index.ts";
import { assert, signed, FIXTURE_TOKEN } from "./fixtures.ts";
import { decodeBase64, FROG_PNG_BASE64 } from "./fixtures/splash-frog.ts";

const identity = {
  me: () => Promise.reject(new Error("unused")),
  ownFrogs: () => Promise.resolve([]),
  selectFrog: () => Promise.resolve(false),
  consents: () => Promise.resolve([]),
  setConsent: () => Promise.resolve(true),
};
const idleRounds = {
  currentRound: () => Promise.resolve(null),
  placeBid: () => Promise.reject(new Error("unused")),
  myBids: () => Promise.resolve([]),
  roundResults: () => Promise.resolve(null),
  advanceRounds: () => Promise.resolve(0),
};
const own: OwnSubmission = {
  submissionId: "11111111-1111-4111-8111-111111111111",
  state: "in_pond",
  submittedAt: "2026-10-16T00:00:00.000Z",
  width: 96,
  height: 96,
  backgroundRemoved: true,
};

function build(access: boolean = false) {
  const submitted: string[] = [];
  const store: SplashStore = {
    ...idleRounds,
    submit: (id) => {
      submitted.push(id);
      return Promise.resolve({
        status: "created",
        submissionId: own.submissionId,
        submittedAt: own.submittedAt,
      });
    },
    pond: () => Promise.resolve([]),
    mine: (id) => {
      assert(id === "101");
      return Promise.resolve([own]);
    },
    image: () => Promise.resolve(null),
  };
  const app = createApp(
    FIXTURE_TOKEN,
    identity,
    [],
    undefined,
    access,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    store,
  );
  return { app, submitted };
}

Deno.test(
  "splash routes require verified identity and ignore body-supplied authors",
  async () => {
    const { app, submitted } = build();
    const png = decodeBase64(FROG_PNG_BASE64);
    const send = (headers: Record<string, string>) =>
      app.request("/v1/splash/submissions?author=102", {
        method: "POST",
        headers: { "content-type": "image/png", ...headers },
        body: png,
      });
    assert((await send({})).status === 401 && submitted.length === 0);
    const authorization = `tma ${await signed()}`;
    const created = await send({ authorization });
    assert(created.status === 201);
    const body = await created.json();
    assert(body.state === "in_pond" && body.background_removed === true);
    assert(submitted.join(",") === "101");
    assert((await app.request("/v1/splash/submissions/mine")).status === 401);
    const mine = await app.request("/v1/splash/submissions/mine", {
      headers: { authorization },
    });
    assert(mine.status === 200);
    assert((await mine.json()).submissions[0].state === "in_pond");
  },
);

Deno.test(
  "pond is readable without login in production mode only",
  async () => {
    const { app } = build();
    assert((await app.request("/v1/splash/pond")).status === 200);
    const staging = build(true).app;
    assert((await staging.request("/v1/splash/pond")).status === 401);
  },
);
