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
