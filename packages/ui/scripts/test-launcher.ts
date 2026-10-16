import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "./fake-dom.ts";
import {
  AppGrid,
  AppTile,
  Embed,
  Identity,
  Screen,
  Text,
} from "../src/index.ts";

await test("AppTile is one button named by the app and described by its tier", () => {
  let opened = 0;
  const tile = fake(
    AppTile({
      name: "governance",
      tier: "official",
      tierLabel: "Official",
      onOpen: () => opened++,
    }),
  );
  assert.equal(tile.tagName, "button");
  assert.equal(tile.type, "button");
  assert.equal(tile.dataset.tier, "official");
  const art = tile.child(0);
  const name = tile.child(1);
  const mark = tile.child(2);
  assert.equal(art.textContent, "G");
  assert.equal(art.getAttribute("aria-hidden"), "true");
  assert.equal(tile.getAttribute("aria-labelledby"), name.id);
  assert.equal(name.textContent, "governance");
  assert.equal(tile.getAttribute("aria-describedby"), mark.id);
  assert.equal(mark.textContent, "Official");
  tile.click();
  assert.equal(opened, 1);
  const platform = fake(
    AppTile({
      name: "Wallet",
      tier: "platform",
      tierLabel: "ignored",
      onOpen: () => opened++,
      disabled: true,
    }),
  );
  assert.equal(platform.children.length, 2, "platform apps carry no mark");
  assert.equal(platform.getAttribute("aria-describedby"), null);
  platform.click();
  assert.equal(opened, 1, "a disabled tile does not open");
});

await test("AppGrid lists tiles in order under a label", () => {
  const tiles = ["A", "B", "C"].map((name) =>
    AppTile({ name, tier: "community", tierLabel: "Community", onOpen() {} }),
  );
  const grid = fake(AppGrid({ label: "Installed apps", tiles }));
  assert.equal(grid.tagName, "ul");
  assert.equal(grid.getAttribute("aria-label"), "Installed apps");
  assert.deepEqual(
    grid.children.map((item) => [
      item.tagName,
      item.child(0).child(1).textContent,
    ]),
    [
      ["li", "A"],
      ["li", "B"],
      ["li", "C"],
    ],
  );
});

await test("Identity shows the avatar, name and caption", () => {
  const identity = fake(Identity({ name: "frog", caption: "Public profile" }));
  assert.equal(identity.child(0).className, "rada-avatar");
  assert.equal(identity.child(1).textContent, "frogPublic profile");
  assert.equal(fake(Identity({ name: "Guest" })).child(1).children.length, 1);
});

await test("Screen places top content above the title; Embed can fill", () => {
  const top = Text("Identity");
  const body = fake(Screen({ title: "Apps", top })).child(1);
  assert.equal(body.child(0), fake(top));
  assert.equal(body.child(1).tagName, "h1");
  assert.equal(fake(Embed()).className, "rada-embed");
  assert.equal(
    fake(Embed({ fill: true })).className,
    "rada-embed rada-embed--fill",
  );
});
