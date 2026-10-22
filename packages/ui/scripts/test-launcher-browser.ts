import { test } from "node:test";
import assert from "node:assert/strict";
import { fake } from "./fake-dom.ts";
import {
  filterLauncher,
  LauncherBrowser,
  type LauncherItem,
} from "../src/launcher-browser.ts";
import { ReorderItem } from "../src/reorder.ts";
import { AppGrid, AppTile } from "../src/launcher.ts";
const items: LauncherItem[] = [
  {
    id: "dao",
    name: "RADA Council",
    tier: "platform",
    group: "rada",
    onOpen() {},
  },
  {
    id: "game",
    name: "\u0416\u0430\u0431\u043a\u0438",
    tier: "community",
    group: "games",
    favourite: true,
    onOpen() {},
  },
];
void test("grid Tab navigation explicitly focuses adjacent enabled tiles in both directions", () => {
  const tiles = ["First", "Disabled", "Last"].map((name) =>
    AppTile({
      name,
      tier: "platform",
      disabled: name === "Disabled",
      onOpen() {},
    }),
  );
  const grid = fake(AppGrid({ label: "Apps", tiles }));
  let prevented = 0;
  const tab = (shiftKey: boolean) => {
    const event = {
      type: "keydown",
      key: "Tab",
      shiftKey,
      preventDefault() {
        prevented++;
      },
    };
    grid.listeners.get("keydown")?.[0]?.run(event);
  };
  tiles[0]?.focus();
  tab(false);
  assert.equal(document.activeElement, tiles[2]);
  tab(true);
  assert.equal(document.activeElement, tiles[0]);
  tab(true);
  assert.equal(prevented, 2, "Tab leaves the grid at its boundary");
});
void test("launcher name search normalizes case and combines groups with favourites", () => {
  assert.deepEqual(
    filterLauncher(items, " \u0440\u0430\u0434\u0430 ", "all"),
    [],
  );
  assert.equal(
    filterLauncher(items, "\u0416\u0410\u0411", "games")[0]?.id,
    "game",
  );
  assert.equal(filterLauncher(items, "rada", "rada")[0]?.id, "dao");
  assert.equal(filterLauncher(items, "", "favourites")[0]?.id, "game");
  assert.equal(filterLauncher(items, "Council", "games").length, 0);
});
void test("instant search retains its input and announces result count", () => {
  const view = fake(
    LauncherBrowser({
      items,
      label: "Apps",
      searchLabel: "Search",
      emptyLabel: "Empty",
      count: String,
      groups: [{ id: "all", label: "All" }],
    }),
  );
  const input = view.child(2).child(0).child(1);
  input.value = "\u0416\u0430\u0431";
  input.dispatch("input");
  assert.equal(view.child(2).child(0).child(1), input);
  assert.equal(view.child(1).textContent, "1");
  assert.equal(view.child(1).getAttribute("aria-live"), "polite");
});
void test("reordering has named native buttons, bounds and keyboard activation", () => {
  const moves: number[] = [];
  const row = fake(
    ReorderItem({
      child: document.createElement("span"),
      name: "Game",
      earlier: "Earlier",
      later: "Later",
      first: true,
      last: false,
      move: (direction) => {
        moves.push(direction);
      },
    }),
  );
  row.child(1).child(0).click();
  row.child(1).child(1).click();
  assert.deepEqual(moves, [1]);
  assert.equal(row.child(1).child(1).getAttribute("aria-label"), "Game: Later");
});

void test("workspace follows the finger before committing and releases cancelled gestures", async (context) => {
  const { workspaceSwipe } = await import("../src/workspace-swipe.ts");
  const physics =
    await import("../../platform-sdk/src/screen-swipe-physics.ts");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const media = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true }),
  });
  const properties = new Map<string, string>();
  class Surface extends EventTarget {
    clientWidth = 390;
    scrollWidth = 390;
    parentElement = null;
    dataset: Record<string, string> = {};
    style = {
      setProperty: (key: string, value: string) => properties.set(key, value),
      removeProperty: (key: string) => properties.delete(key),
    };
    closest() {
      return null;
    }
    setPointerCapture() {}
    removeAttribute() {}
  }
  const surface = new Surface();
  let index = 1;
  let enabled = true;
  const selected: number[] = [];
  const swipe = workspaceSwipe(surface as unknown as HTMLElement, {
    physics,
    enabled: () => enabled,
    index: () => index,
    select(value) {
      selected.push(value);
      index = value;
    },
    track: () => surface as unknown as HTMLElement,
    settled() {},
  });
  const pointer = (type: string, x: number, y = 200) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
      isPrimary: true,
    });
    surface.dispatchEvent(event);
  };
  try {
    pointer("pointerdown", 300);
    pointer("pointermove", 200);
    assert.equal(properties.get("--workspace-drag"), "-100px");
    assert.deepEqual(selected, []);
    assert.equal(swipe.active(), true);
    pointer("pointercancel", 200);
    context.mock.timers.tick(1);
    assert.deepEqual(selected, []);
    assert.equal(swipe.active(), false);
    pointer("pointerdown", 300);
    pointer("pointermove", 80);
    pointer("pointerup", 80);
    context.mock.timers.tick(1);
    assert.deepEqual(selected, [2]);
    const click = (detail: number) => {
      const event = new Event("click", { cancelable: true });
      Object.defineProperty(event, "detail", { value: detail });
      surface.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(
      click(0),
      false,
      "keyboard activation survives swipe settling",
    );
    assert.equal(
      click(1),
      true,
      "the swipe's trailing pointer click is suppressed",
    );
    enabled = false;
    assert.equal(
      click(1),
      false,
      "screen controls outside the workspace own clicks",
    );
    enabled = true;
    pointer("pointerdown", 300);
    pointer("pointermove", 80);
    assert.ok(
      Number.parseFloat(properties.get("--workspace-drag") ?? "0") > -86,
    );
    pointer("pointerup", 80);
    context.mock.timers.tick(1);
    assert.deepEqual(selected, [2]);
    pointer("pointerdown", 300);
    pointer("pointermove", 280, 280);
    pointer("pointermove", 80, 285);
    pointer("pointerup", 80, 285);
    assert.deepEqual(selected, [2]);
  } finally {
    swipe.dispose();
    if (media) Object.defineProperty(globalThis, "matchMedia", media);
    else Reflect.deleteProperty(globalThis, "matchMedia");
  }
});
