// deno-lint-ignore-file require-await
import { test } from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { governanceMembershipSnapshot } from "./governance-membership.ts";
test("snapshot omits Telegram identifiers and fails on unavailable", async () => {
  const service = {
    query: async () => ({
      rows: [
        { subject_id: "subject", telegram_id: "101" },
        { subject_id: "departed", telegram_id: "102" },
      ],
    }),
  } as unknown as pg.Pool;
  const result = await governanceMembershipSnapshot(service, {
    status: async (id) => (id === "101" ? "member" : "not_member"),
  });
  assert.deepEqual(result.members, ["subject"]);
  assert.equal(JSON.stringify(result).includes("101"), false);
  await assert.rejects(
    governanceMembershipSnapshot(service, {
      status: async () => "unavailable",
    }),
  );
});
