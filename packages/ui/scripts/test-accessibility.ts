import assert from "node:assert/strict";
import { test } from "node:test";
import { compileTheme, contrastRatio } from "../src/theme-compiler.ts";

const surfaces = [
  "--water-top",
  "--water-mid",
  "--water-bottom",
  "--surface-base",
  "--surface-raised",
  "--surface-soft",
  "--control-selected-bg",
] as const;
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (channels: number[]) =>
  `#${channels.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;

await test("primary and translucent secondary ink read on every material", () => {
  for (const background of [
    "#808080",
    "#0000FF",
    ...Array.from({ length: 4096 }, (_, i) =>
      hex(rgb(`#${((i * 7919) % 16777216).toString(16).padStart(6, "0")}`)),
    ),
  ]) {
    const tokens = compileTheme(background, background).tokens;
    const muted = tokens["--text-muted"].match(/[\d.]+/g)?.map(Number) ?? [];
    for (const surface of surfaces) {
      const backing = tokens[surface];
      const composite = rgb(backing).map(
        (c, i) => c * (1 - (muted[3] ?? 1)) + (muted[i] ?? 0) * (muted[3] ?? 1),
      );
      assert.ok(
        contrastRatio(backing, tokens["--text-primary"]) >= 4.5,
        `${background} primary on ${surface}`,
      );
      assert.ok(
        contrastRatio(backing, hex(composite)) >= 4.5,
        `${background} secondary on ${surface}`,
      );
    }
  }
});

await test("dual focus ring has a contrasting band on authored and derived surfaces", () => {
  for (const background of [
    "#FFFFFF",
    "#121212",
    "#808080",
    "#0000FF",
    "#243B34",
  ]) {
    const tokens = compileTheme(background, background).tokens;
    for (const backing of [background, ...surfaces.map((key) => tokens[key])]) {
      assert.ok(
        Math.max(
          contrastRatio(backing, tokens["--theme-ring"]),
          contrastRatio(backing, tokens["--accent-ring"]),
        ) >= 3,
      );
    }
    assert.equal(
      contrastRatio(tokens["--theme-ring"], tokens["--accent-ring"]),
      21,
    );
  }
});

await test("mid-gray adjusts only unreadable water stops and preserves exact traits", () => {
  const tokens = compileTheme("#808080", "#808080").tokens;
  assert.equal(tokens["--theme-base"], "#808080");
  assert.equal(tokens["--accent-solid"], "#808080");
  assert.equal(tokens["--water-top"], "#848484");
  assert.equal(tokens["--surface-base"], "#8A8A8A");
  assert.equal(tokens["--surface-raised"], "#979797");
  assert.equal(tokens["--water-mid"], "#828282");
  assert.equal(tokens["--water-bottom"], "#828282");
  assert.ok(contrastRatio("#818181", tokens["--text-primary"]) < 5);
  assert.ok(contrastRatio("#828282", tokens["--text-primary"]) >= 5);
});

await test("selected rows resolve their accent tint before painting on ambient canvas", () => {
  const tokens = compileTheme("#164E42").tokens;
  assert.match(tokens["--control-selected-bg"], /^#[0-9A-F]{6}$/);
  assert.equal(tokens["--accent-solid"], "#F4F4F0");
  const alpha = Number(tokens["--text-muted"].match(/\/ ([\d.]+)/)?.[1]);
  const background = tokens["--control-selected-bg"];
  const foreground = rgb(background).map(
    (channel, i) =>
      channel * (1 - alpha) + (rgb(tokens["--text-primary"])[i] ?? 0) * alpha,
  );
  assert.ok(contrastRatio(background, hex(foreground)) >= 5);
});
