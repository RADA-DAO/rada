import { test } from "node:test";
import assert from "node:assert/strict";
import { launcherGroup } from "../src/home.ts";
import { filterLauncher } from "../../../packages/ui/src/launcher-browser.ts";

void test("launcher groups built-ins and registry categories independently of trust tier", () => {
  for (const id of ["governance", "treasury", "holders"])
    assert.equal(launcherGroup({ id: `builtin:${id}` }), "rada");
  assert.equal(launcherGroup({ id: "builtin:splash" }), "games");
  for (const tier of ["official", "community"]) {
    assert.equal(
      launcherGroup({ tier, manifest: { category: "games" } }),
      "games",
    );
  }
  assert.equal(launcherGroup({ tier: "official" }), "rada");
  assert.equal(launcherGroup({ tier: "community" }), "apps");
  assert.equal(launcherGroup({ manifest: { category: "apps" } }), "apps");
});

void test("favourites include only saved available apps, including games in personal folders", () => {
  const item = {
    id: "game",
    name: "Game",
    tier: "community" as const,
    group: "games",
    inFolder: true,
    onOpen() {},
  };
  assert.deepEqual(filterLauncher([item], "", "favourites"), []);
  assert.equal(
    filterLauncher([{ ...item, favourite: true }], "", "favourites")[0]?.id,
    "game",
  );
  assert.equal(filterLauncher([item], "", "games")[0]?.id, "game");
});
