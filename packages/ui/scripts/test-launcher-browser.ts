import { test } from "node:test";
import assert from "node:assert/strict";
import { fake } from "./fake-dom.ts";
import {
  filterLauncher,
  LauncherBrowser,
  type LauncherItem,
} from "../src/launcher-browser.ts";
import { ReorderItem } from "../src/reorder.ts";
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
  const input = view.child(0).child(0).child(1);
  input.value = "\u0416\u0430\u0431";
  input.dispatch("input");
  assert.equal(view.child(0).child(0).child(1), input);
  assert.equal(view.child(2).textContent, "1");
  assert.equal(view.child(2).getAttribute("aria-live"), "polite");
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
