import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Mission, ReputationStore } from "../contract.ts";

/** Adapter-only fixture: tests never substitute an in-memory implementation for the store. */
export interface StoreFixture {
  store: ReputationStore;
  actor: string;
  otherActor: string;
  seedMission: (input: {
    points: string;
    verifier: "acknowledgement" | "external";
  }) => Promise<Mission>;
  close(): Promise<void>;
}
export type StoreFixtureFactory = () => Promise<StoreFixture>;

export function reputationContractTests(factory: StoreFixtureFactory): void {
  const scenario = (
    name: string,
    run: (fixture: StoreFixture) => Promise<void>,
  ) =>
    test(name, { concurrency: false }, async () => {
      const fixture = await factory();
      try {
        await run(fixture);
      } finally {
        await fixture.close();
      }
    });
  const input = (mission: Mission) => ({
    requestId: randomUUID(),
    missionVersion: mission.version,
  });
  void scenario(
    "receipts survive lost responses and replay remains immutable after later writes",
    async ({ store, actor, seedMission }) => {
      const mission = await seedMission({
        points: "1.2345",
        verifier: "acknowledgement",
      });
      const request = input(mission);
      const committed = await store.verify(actor, mission.id, request);
      assert.equal(committed.summary.totalPoints, "1.2345");
      assert.equal(committed.summary.lifetimePoints, "1.2345");
      assert.equal(committed.item.points, "1.2345");
      // Simulate a connection dropping after commit: caller recovers through command lookup.
      assert.deepEqual(
        await store.command(actor, request.requestId),
        committed,
      );
      await store.report(actor, {
        requestId: randomUUID(),
        title: "Independent concrete work",
        description: "Prepared a synthetic draft",
        occurredAt: new Date().toISOString(),
      });
      assert.deepEqual(
        await store.verify(actor, mission.id, request),
        committed,
      );
      assert.deepEqual(
        await store.command(actor, request.requestId),
        committed,
      );
      assert.equal((await store.summary(actor, "all")).totalPoints, "1.2345");
    },
  );
  void scenario(
    "same request ID conflicts with changed payload and a different operation",
    async ({ store, actor, seedMission }) => {
      const requestId = randomUUID();
      const report = {
        requestId,
        title: "Synthetic work",
        description: "A concrete synthetic result",
        occurredAt: "2020-11-01T12:00:00Z",
      };
      const first = await store.report(actor, report);
      await assert.rejects(
        store.report(actor, { ...report, description: "Changed meaning" }),
      );
      const mission = await seedMission({
        points: "2",
        verifier: "acknowledgement",
      });
      await assert.rejects(
        store.verify(actor, mission.id, {
          requestId,
          missionVersion: mission.version,
        }),
      );
      assert.deepEqual(await store.command(actor, requestId), first);
      assert.equal((await store.summary(actor, "all")).totalPoints, "0");
    },
  );
  void scenario(
    "parallel distinct requests for one semantic occurrence award exactly once",
    async ({ store, actor, seedMission }) => {
      const mission = await seedMission({
        points: "1.2345",
        verifier: "acknowledgement",
      });
      const requests = Array.from({ length: 8 }, () => input(mission));
      const results = await Promise.all(
        requests.map((request) => store.verify(actor, mission.id, request)),
      );
      assert.equal(new Set(results.map((result) => result.item.id)).size, 1);
      assert.ok(results.every((result) => result.state === "completed"));
      for (const [index, request] of requests.entries())
        assert.deepEqual(
          await store.command(actor, request.requestId),
          results[index],
        );
      const summary = await store.summary(actor, "all");
      assert.equal(summary.totalPoints, "1.2345");
      assert.equal(summary.lifetimePoints, "1.2345");
      assert.equal((await store.items(actor, "all", null)).items.length, 1);
    },
  );
  void scenario(
    "external checking and attachment-free reports never become accepted awards",
    async ({ store, actor, seedMission }) => {
      const external = await seedMission({
        points: "99",
        verifier: "external",
      });
      const checking = await store.verify(actor, external.id, input(external));
      assert.equal(checking.state, "checking");
      assert.equal(checking.item.status, "pending");
      assert.equal(checking.summary.pendingCount, 1);
      const report = await store.report(actor, {
        requestId: randomUUID(),
        title: "Draft produced",
        description: "Prepared and shared an original outline",
        occurredAt: new Date().toISOString(),
      });
      assert.equal(report.state, "checking");
      assert.equal(report.item.status, "pending");
      const summary = await store.summary(actor, "all");
      assert.equal(summary.totalPoints, "0");
      assert.equal(summary.pendingCount, 2);
    },
  );
  void scenario(
    "actor boundaries cover items, receipts, appeals, feeds and cursors",
    async ({ store, actor, otherActor, seedMission }) => {
      const mission = await seedMission({
        points: "3",
        verifier: "acknowledgement",
      });
      const request = input(mission);
      const owned = await store.verify(actor, mission.id, request);
      const appeal = await store.appeal(actor, owned.item.id, {
        requestId: randomUUID(),
        message: "Synthetic clarification",
      });
      assert.equal(await store.item(otherActor, owned.item.id), null);
      assert.equal(await store.command(otherActor, request.requestId), null);
      assert.equal((await store.summary(otherActor, "all")).totalPoints, "0");
      assert.deepEqual((await store.items(otherActor, "all", null)).items, []);
      assert.deepEqual((await store.changes(otherActor, "0")).changes, []);
      const foreignCursor = await store.changes(
        otherActor,
        (await store.summary(actor, "all")).revision,
      );
      assert.deepEqual(foreignCursor.changes, []);
      assert.equal(foreignCursor.resetRequired, true);
      assert.equal(foreignCursor.nextCursor, "0");
      await store.appeals(otherActor, owned.item.id).then(
        (rows) => {
          assert.deepEqual(rows, []);
        },
        (error: unknown) => {
          assert.ok(error instanceof Error);
        },
      );
      await assert.rejects(
        store.appeal(otherActor, owned.item.id, {
          requestId: randomUUID(),
          message: "Unauthorized",
        }),
      );
      assert.ok(
        (await store.appeals(actor, owned.item.id)).some(
          (item) => item.id === appeal.id,
        ),
      );
      // Same opaque request key is safe to use for another authenticated subject.
      const second = await store.verify(otherActor, mission.id, request);
      assert.notEqual(second.item.id, owned.item.id);
      assert.equal((await store.summary(otherActor, "all")).totalPoints, "3");
    },
  );
  void scenario(
    "appeals preserve accepted points and their own request is idempotent",
    async ({ store, actor, seedMission }) => {
      const mission = await seedMission({
        points: "2.5",
        verifier: "acknowledgement",
      });
      const award = await store.verify(actor, mission.id, input(mission));
      const request = {
        requestId: randomUUID(),
        message: "Please clarify the attribution",
      };
      const appeal = await store.appeal(actor, award.item.id, request);
      assert.deepEqual(
        await store.appeal(actor, award.item.id, request),
        appeal,
      );
      await assert.rejects(
        store.appeal(actor, award.item.id, {
          ...request,
          message: "Different content",
        }),
      );
      assert.equal(
        (await store.item(actor, award.item.id))?.status,
        "accepted",
      );
      assert.equal((await store.summary(actor, "all")).totalPoints, "2.5");
      assert.equal((await store.appeals(actor, award.item.id)).length, 1);
    },
  );
  void scenario(
    "durable changes reconnect without lost events or another actor's rows",
    async ({ store, actor, otherActor }) => {
      const before = await store.changes(actor, "0");
      const written = [];
      for (let index = 0; index < 105; index++) {
        const receipt = await store.report(actor, {
          requestId: randomUUID(),
          title: `Synthetic result ${String(index)}`,
          description: "A concrete result for cursor recovery",
          occurredAt: new Date().toISOString(),
        });
        written.push(receipt.item.id);
      }
      let cursor = before.nextCursor;
      const seen: string[] = [];
      let pages = 0;
      for (;;) {
        const page = await store.changes(actor, cursor);
        assert.equal(page.resetRequired, false);
        for (const change of page.changes) {
          assert.ok(BigInt(change.revision) > BigInt(cursor));
          cursor = change.revision;
          seen.push(change.itemId);
        }
        assert.ok(BigInt(page.nextCursor) >= BigInt(cursor));
        cursor = page.nextCursor;
        assert.ok(++pages < 10, "bounded changes feed must make progress");
        if (!page.hasMore) break;
      }
      assert.equal(new Set(seen).size, written.length);
      assert.deepEqual([...new Set(seen)].sort(), written.sort());
      assert.deepEqual((await store.changes(actor, cursor)).changes, []);
      assert.deepEqual((await store.changes(otherActor, "0")).changes, []);
    },
  );
}
