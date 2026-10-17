// deno-lint-ignore-file require-await
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramMembershipProvider } from "./membership.ts";
test("fresh eligibility checks bypass cached display membership", async () => {
  let calls = 0;
  const provider = new TelegramMembershipProvider("fixture", "-1", {
    fetch: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            user: { id: 101 },
            status: calls === 1 ? "member" : "left",
          },
        }),
      );
    },
  });
  assert.equal(await provider.status("101"), "member");
  assert.equal(await provider.status("101"), "member");
  assert.equal(calls, 1);
  assert.equal(await provider.status("101", true), "not_member");
  assert.equal(calls, 2);
});
