import assert from "node:assert/strict";
import { test } from "node:test";
import { fake, fakeDocument, mutations } from "./fake-dom.ts";
import { AppTile, Button, Screen, ScreenHost } from "../src/index.ts";
import { openSheet } from "../src/sheet.ts";
import { restoreSheetFocus } from "../src/focus.ts";
import { workspaceSwipe } from "../src/workspace-swipe.ts";
import * as physics from "../../platform-sdk/src/screen-swipe-physics.ts";

await test("content owns refresh focus; shell routes and sheet openers restore live targets", () => {
  const host = ScreenHost(fakeDocument.body as unknown as HTMLElement);
  const first = Screen({ title: "Pond" });
  fake(host).append(fake(first));
  mutations.at(-1)?.();
  assert.equal(fakeDocument.activeElement?.textContent, "Pond");
  const opener = Button("Bid");
  opener.dataset.focusKey = "bid:1";
  fake(first).append(fake(opener));
  opener.focus();
  const replacement = Button("Raise bid");
  replacement.dataset.focusKey = "bid:1";
  fake(opener).remove();
  fake(first).append(fake(replacement));
  fakeDocument.activeElement = fakeDocument.body;
  mutations.at(-1)?.();
  assert.equal(fakeDocument.activeElement, fakeDocument.body);
  restoreSheetFocus(opener);
  assert.equal(fakeDocument.activeElement, fake(replacement));
  replacement.disabled = true;
  restoreSheetFocus(opener);
  assert.equal(fakeDocument.activeElement.textContent, "Pond");
  fake(host).replaceChildren(fake(Screen({ title: "Results" })));
  mutations.at(-1)?.();
  assert.equal(fakeDocument.activeElement.textContent, "Results");
});

await test("touch capture transfer preserves workspace swipes from children and the root edge", async () => {
  const listeners = new Map<string, (event: PointerEvent) => void>();
  const host = {
    clientWidth: 390,
    addEventListener: (name: string, listener: (event: PointerEvent) => void) =>
      listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
    setPointerCapture() {},
  } as unknown as HTMLElement;
  const track = {
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    removeAttribute() {},
  } as unknown as HTMLElement;
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
  let index = 0;
  const swipe = workspaceSwipe(host, {
    physics,
    enabled: () => true,
    index: () => index,
    select: (next) => (index = next),
    track: () => track,
    settled() {},
  });
  const child = {
    closest: () => null,
    parentElement: host,
    scrollWidth: 0,
    clientWidth: 0,
  };
  const send = (name: string, x: number, target: unknown = host) =>
    listeners.get(name)?.({
      target,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: 300,
      timeStamp: performance.now(),
      preventDefault() {},
    } as PointerEvent);
  for (const [from, to, expected] of [
    [330, 24, 1],
    [4, 350, 0],
  ] as const) {
    send("pointerdown", from, child);
    send("pointermove", to);
    send("lostpointercapture", to, child);
    assert.equal(swipe.active(), true);
    send("pointerup", to);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(index, expected);
    assert.equal(swipe.active(), false);
  }
  swipe.dispose();
});

await test("workspace focus skips headings in inactive pages", () => {
  fakeDocument.body.replaceChildren();
  const host = ScreenHost(fakeDocument.body as unknown as HTMLElement);
  const inactive = Screen({ title: "Inactive profile" });
  inactive.setAttribute("inert", "");
  const active = Screen({ title: "Desktop" });
  fake(host).replaceChildren(fake(inactive), fake(active));
  mutations.at(-1)?.();
  assert.ok(fakeDocument.activeElement);
  assert.equal(fakeDocument.activeElement.textContent, "Desktop");
  restoreSheetFocus();
  assert.equal(fakeDocument.activeElement.textContent, "Desktop");
});

await test("a launcher refresh restores its focused tile without scrolling the workspace", () => {
  fakeDocument.body.replaceChildren();
  const host = ScreenHost(fakeDocument.body as unknown as HTMLElement);
  const tile = () => AppTile({ name: "Game", tier: "platform", onOpen() {} });
  const first = tile();
  fake(host).append(fake(Screen({ title: "Apps", children: [first] })));
  mutations.at(-1)?.();
  first.focus();
  const replacement = tile();
  const focus: FocusOptions[] = [];
  const nativeFocus = replacement.focus.bind(replacement);
  replacement.focus = (options) => {
    focus.push(options ?? {});
    nativeFocus(options);
  };
  fake(host).replaceChildren(
    fake(Screen({ title: "Apps", children: [replacement] })),
  );
  mutations.at(-1)?.();
  assert.equal(fakeDocument.activeElement, fake(replacement));
  assert.deepEqual(focus, [{ preventScroll: true }]);
});

await test("moving a live profile action restores focus lost during reparenting", () => {
  fakeDocument.body.replaceChildren();
  const host = ScreenHost(fakeDocument.body as unknown as HTMLElement);
  const settings = Button("Settings");
  settings.dataset.focusKey = "shell-settings";
  const view = Screen({ title: "Profile", actions: [settings] });
  fake(host).append(fake(view));
  mutations.at(-1)?.();
  settings.focus();
  fake(settings).remove();
  fake(view).append(fake(settings));
  fakeDocument.activeElement = fakeDocument.body;
  const focus: FocusOptions[] = [];
  const nativeFocus = settings.focus.bind(settings);
  settings.focus = (options) => {
    focus.push(options ?? {});
    nativeFocus(options);
  };
  mutations.at(-1)?.();
  assert.equal(fakeDocument.activeElement, fake(settings));
  assert.deepEqual(focus, [{ preventScroll: true }]);

  const next = Button("Next");
  fake(view).append(fake(next));
  next.focus();
  mutations.at(-1)?.();
  assert.equal(fakeDocument.activeElement, fake(next));
  assert.equal(focus.length, 1);
});

await test("a queued sheet close never steals focus from a screen control", () => {
  fakeDocument.body.replaceChildren();
  const opener = Button("Rules");
  const next = Button("Next");
  fakeDocument.body.append(fake(opener), fake(next));
  const sheet = fake(
    openSheet({ title: "Rules", closeLabel: "Close", opener }),
  );
  sheet.open = false;
  next.focus();
  fake(opener).remove();
  sheet.dispatch("close");
  assert.equal(fakeDocument.activeElement, fake(next));
  assert.equal(sheet.isConnected, false);
});

await test("a sheet with a removed opener restores the active screen heading", () => {
  fakeDocument.body.replaceChildren();
  const host = ScreenHost(fakeDocument.body as unknown as HTMLElement);
  const opener = Button("Rules");
  fake(host).append(fake(Screen({ title: "Arena", children: [opener] })));
  const sheet = fake(
    openSheet({ title: "Rules", closeLabel: "Close", opener }),
  );
  sheet.child(0).child(0).focus();
  fake(opener).remove();
  sheet.close();
  assert.equal(fakeDocument.activeElement?.textContent, "Arena");
});
