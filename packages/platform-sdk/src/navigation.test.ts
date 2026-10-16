import assert from "node:assert/strict";
import test from "node:test";
import { createNavigation, type NavEntry } from "./navigation.ts";

/** A browser history that delivers popstate asynchronously, like real engines. */
function fakeBrowser() {
  const entries: unknown[] = [null];
  let index = 0;
  const handlers = new Set<(event: Event) => void>();
  const calls: string[] = [];
  const history = {
    pushState(state: unknown) {
      entries.splice(index + 1, entries.length, state);
      index++;
      calls.push("push");
    },
    replaceState(state: unknown) {
      entries[index] = state;
      calls.push("replace");
    },
    go(delta: number) {
      calls.push(`go${String(delta)}`);
      index = Math.max(0, Math.min(entries.length - 1, index + delta));
      const state = entries[index];
      queueMicrotask(() => {
        for (const handler of handlers)
          handler({ state } as unknown as PopStateEvent);
      });
    },
  };
  const target = {
    addEventListener: (_: string, handler: (event: Event) => void) =>
      handlers.add(handler),
    removeEventListener: (_: string, handler: (event: Event) => void) =>
      handlers.delete(handler),
  };
  return {
    history,
    target,
    calls,
    browserBack() {
      history.go(-1);
    },
    get index() {
      return index;
    },
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup() {
  const browser = fakeBrowser();
  const left: string[] = [];
  const entry = (key: string, extra: Partial<NavEntry> = {}): NavEntry => ({
    key,
    leave: () => left.push(key),
    ...extra,
  });
  const nav = createNavigation(entry("home"), browser);
  return { browser, left, nav, entry };
}

await test("push and back keep stack, history and leave callbacks in step", async () => {
  const { browser, left, nav, entry } = setup();
  nav.push(entry("profile"));
  nav.push(entry("review"));
  assert.equal(nav.depth, 3);
  assert.equal(browser.index, 2);
  assert.equal(nav.back(), true);
  assert.equal(nav.top.key, "profile");
  assert.deepEqual(left, ["review"]);
  await settle();
  assert.equal(browser.index, 1);
  assert.equal(nav.back(), true);
  assert.equal(nav.back(), false);
  assert.equal(nav.canGoBack, false);
});

await test("our own history traversal does not pop a second time", async () => {
  const { left, nav, entry } = setup();
  nav.push(entry("a"));
  nav.push(entry("b"));
  nav.back();
  await settle();
  assert.equal(nav.top.key, "a");
  assert.deepEqual(left, ["b"]);
});

await test("browser Back pops the stack", async () => {
  const { browser, left, nav, entry } = setup();
  nav.push(entry("a"));
  nav.push(entry("b"));
  browser.browserBack();
  await settle();
  assert.equal(nav.top.key, "a");
  assert.deepEqual(left, ["b"]);
});

await test("pushing a key already in the stack unwinds to it", async () => {
  const { left, nav, entry } = setup();
  nav.push(entry("profile"));
  nav.push(entry("review"));
  nav.push(entry("profile"));
  await settle();
  assert.equal(nav.top.key, "profile");
  assert.equal(nav.depth, 2);
  assert.deepEqual(left, ["review"]);
  nav.push(entry("profile"));
  assert.equal(nav.depth, 2);
});

await test("drop removes a self-closed entry without calling its leave", async () => {
  const { left, nav, entry } = setup();
  nav.push(entry("profile"));
  nav.push(entry("sheet"));
  nav.drop("sheet");
  await settle();
  assert.equal(nav.top.key, "profile");
  assert.deepEqual(left, []);
  nav.drop("sheet");
  assert.equal(nav.depth, 2);
});

await test("a guard consumes app Back and undoes browser Back", async () => {
  const { browser, nav, entry } = setup();
  nav.push(entry("a"));
  let busy = true;
  nav.setGuard(() => busy);
  assert.equal(nav.back(), true);
  assert.equal(nav.top.key, "a");
  browser.browserBack();
  await settle();
  assert.equal(nav.top.key, "a");
  assert.equal(browser.index, 1);
  busy = false;
  assert.equal(nav.back(), true);
  assert.equal(nav.top.key, "home");
});

await test("history writes wait for an in-flight traversal", async () => {
  const { browser, nav, entry } = setup();
  nav.push(entry("app"));
  nav.back();
  nav.push(entry("sheet"));
  assert.equal(browser.calls.at(-1), "go-1");
  await settle();
  assert.equal(browser.calls.at(-1), "push");
  assert.equal(browser.index, 1);
});

await test("replace swaps the top entry in place", () => {
  const { browser, left, nav, entry } = setup();
  nav.push(entry("a"));
  nav.replace(entry("b"));
  assert.equal(nav.depth, 2);
  assert.equal(nav.top.key, "b");
  assert.deepEqual(left, ["a"]);
  assert.equal(browser.index, 1);
});

await test("subscribers hear every change until they unsubscribe", () => {
  const { nav, entry } = setup();
  let count = 0;
  const off = nav.subscribe(() => count++);
  nav.push(entry("a"));
  nav.back();
  off();
  nav.push(entry("b"));
  assert.equal(count, 2);
});
