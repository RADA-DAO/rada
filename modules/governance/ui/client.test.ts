import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
import { governanceClient, GovernanceError } from "./client.ts";
await test("signed public reads satisfy staging guard; guests omit credentials", async () => {
  const calls: boolean[] = [];
  const api: ModuleApi = {
    url: (path) => path,
    request: (_method, _path, options) => {
      calls.push(options?.auth ?? true);
      return Promise.resolve({
        status: 200,
        body: { proposals: [] },
        retryAfter: null,
      });
    },
  };
  const signal = new AbortController().signal;
  await governanceClient(api, signal, true).read("/proposals", "proposals");
  await governanceClient(api, signal).read("/proposals", "proposals");
  assert.deepEqual(calls, [true, false]);
});
await test("refused writes preserve status and retry-after without exposing server data", async () => {
  const api: ModuleApi = {
    url: (path) => path,
    request: () =>
      Promise.resolve({
        status: 429,
        body: { error: "private-server-detail" },
        retryAfter: 120,
      }),
  };
  await assert.rejects(
    governanceClient(api, new AbortController().signal, true).write(
      "/proposals",
      {},
    ),
    (error: unknown) => {
      assert.ok(error instanceof GovernanceError);
      assert.equal(error.status, 429);
      assert.equal(error.retryAfter, 120);
      assert.equal(error.message, "429");
      return true;
    },
  );
});
