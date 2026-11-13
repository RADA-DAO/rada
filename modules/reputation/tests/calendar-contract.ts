import { test } from "node:test";
import assert from "node:assert/strict";
import type { Period } from "../contract.ts";
import type { StoreFixture } from "./store-contract.ts";
export interface CalendarFixture extends StoreFixture {
  /** Call the production SQL bounds helper with an explicit reference instant. */
  bounds: (
    period: Period,
    reference: string,
  ) => Promise<{ start: string | null; end: string }>;
  /** Test-owner seeding only; production request paths never accept scores. */
  seedAccepted: (
    actor: string,
    occurredAt: string,
    points: string,
  ) => Promise<string>;
}
export function reputationCalendarTests(
  factory: () => Promise<CalendarFixture>,
): void {
  void test("Kyiv weeks straddling DST have exact 167/169-hour boundaries", async () => {
    const f = await factory();
    try {
      const spring = await f.bounds("previous_week", "2026-03-30T10:00:00Z");
      const autumn = await f.bounds("previous_week", "2026-10-26T10:00:00Z");
      assert.equal(
        new Date(spring.start ?? "").toISOString(),
        "2026-03-22T22:00:00.000Z",
      );
      assert.equal(
        new Date(spring.end).toISOString(),
        "2026-03-29T21:00:00.000Z",
      );
      assert.equal(
        Date.parse(spring.end) - Date.parse(spring.start ?? ""),
        167 * 3600000,
      );
      assert.equal(
        new Date(autumn.start ?? "").toISOString(),
        "2026-10-18T21:00:00.000Z",
      );
      assert.equal(
        new Date(autumn.end).toISOString(),
        "2026-10-25T22:00:00.000Z",
      );
      assert.equal(
        Date.parse(autumn.end) - Date.parse(autumn.start ?? ""),
        169 * 3600000,
      );
      const midnight = await f.bounds("today", "2026-03-29T21:00:00Z");
      assert.equal(
        new Date(midnight.start ?? "").toISOString(),
        "2026-03-29T21:00:00.000Z",
      );
    } finally {
      await f.close();
    }
  });
  void test("summary and item periods include start and exclude end; lifetime stays independent", async () => {
    const f = await factory();
    try {
      const before = await f.store.summary(f.actor, "previous_week");
      assert.ok(before.start);
      const beforeId = await f.seedAccepted(
        f.actor,
        new Date(Date.parse(before.start) - 1).toISOString(),
        "1",
      );
      const startId = await f.seedAccepted(f.actor, before.start, "2");
      const insideId = await f.seedAccepted(
        f.actor,
        new Date(Date.parse(before.end) - 1).toISOString(),
        "4",
      );
      const endId = await f.seedAccepted(f.actor, before.end, "8");
      const summary = await f.store.summary(f.actor, "previous_week");
      assert.equal(summary.totalPoints, "6");
      assert.equal(summary.lifetimePoints, "15");
      const ids = (await f.store.items(f.actor, "previous_week", null)).items
        .map((row) => row.id)
        .sort();
      assert.deepEqual(ids, [startId, insideId].sort());
      assert.ok(!ids.includes(beforeId) && !ids.includes(endId));
      assert.equal((await f.store.summary(f.actor, "all")).totalPoints, "15");
    } finally {
      await f.close();
    }
  });
}
