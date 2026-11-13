import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type pg from "pg";
import { ReputationHints } from "./hints.ts";

class Client extends EventEmitter {
  queries: string[] = [];
  released: boolean[] = [];
  query(sql: string) {
    this.queries.push(sql);
    return Promise.resolve({ rows: [] });
  }
  release(destroy = false) {
    this.released.push(destroy);
  }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
test("one LISTEN connection scopes hints, resyncs registration race and cleans up", async () => {
  const clients: Client[] = [];
  const hints = new ReputationHints({
    connect: () => {
      const c = new Client();
      clients.push(c);
      return Promise.resolve(c);
    },
  } as unknown as pg.Pool);
  let a = 0;
  let b = 0;
  const offA = hints.subscribe("subject-a", () => a++);
  const offB = hints.subscribe("subject-b", () => b++);
  await flush();
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]!.queries, ["LISTEN reputation_changes"]);
  assert.equal(a, 1);
  assert.equal(b, 1); // mandatory resync after LISTEN
  clients[0]!.emit("notification", {
    channel: "reputation_changes",
    payload: JSON.stringify({ subject: "subject-a", revision: "1" }),
  });
  assert.equal(a, 2);
  assert.equal(b, 1);
  clients[0]!.emit("notification", {
    channel: "reputation_changes",
    payload: "malformed",
  });
  offA();
  await flush();
  assert.equal(clients[0]!.released.length, 0);
  offB();
  await flush();
  assert.deepEqual(clients[0]!.queries, [
    "LISTEN reputation_changes",
    "UNLISTEN reputation_changes",
  ]);
  assert.deepEqual(clients[0]!.released, [false]);
  await hints.dispose();
  assert.equal(clients[0]!.listenerCount("notification"), 0);
});
test("listener reconnects and disposal destroys no unrelated pool sessions", async () => {
  const clients: Client[] = [];
  const hints = new ReputationHints({
    connect: () => {
      const c = new Client();
      clients.push(c);
      return Promise.resolve(c);
    },
  } as unknown as pg.Pool);
  let wakes = 0;
  hints.subscribe("subject-a", () => wakes++);
  await flush();
  clients[0]!.emit("error", new Error("synthetic disconnect"));
  assert.deepEqual(clients[0]!.released, [true]);
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.equal(clients.length, 2);
  assert.equal(wakes, 2);
  await hints.dispose();
  assert.deepEqual(clients[1]!.released, [false]);
  assert.equal(clients[1]!.listenerCount("notification"), 0);
});
test("unsubscribe during connecting cannot retain a pooled session", async () => {
  let resolveClient!: (client: Client) => void;
  const client = new Client();
  const hints = new ReputationHints({
    connect: () =>
      new Promise<Client>((resolve) => {
        resolveClient = resolve;
      }),
  } as unknown as pg.Pool);
  const off = hints.subscribe("subject", () => {});
  off();
  resolveClient(client);
  await flush();
  assert.deepEqual(client.queries, []);
  assert.deepEqual(client.released, [false]);
  await hints.dispose();
});
