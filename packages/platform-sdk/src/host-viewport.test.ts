import test from "node:test";
import assert from "node:assert/strict";
import { hostInsets, syncHostViewport } from "./host-viewport.ts";

await test("host insets reject malformed dimensions and preserve overlapping spaces", () => {
  assert.deepEqual(
    hostInsets({
      safeAreaInset: { top: 44, left: Number.NaN, right: -1, bottom: 999 },
      contentSafeAreaInset: { top: 32, bottom: Number.POSITIVE_INFINITY },
    }),
    {
      top: { safe: 44, content: 32 },
      right: { safe: 0, content: 0 },
      bottom: { safe: 320, content: 0 },
      left: { safe: 0, content: 0 },
    },
  );
});

await test("fullscreen keeps native clearance without adding two overlapping top insets", () => {
  const properties = new Map<string, string>();
  const root = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
    },
    dataset: { telegramFullscreen: "false" },
  } as unknown as HTMLElement;
  syncHostViewport(root, {
    safeAreaInset: { top: 44 },
    contentSafeAreaInset: { top: 32 },
    isFullscreen: true,
  });
  assert.equal(
    properties.get("--app-safe-top"),
    "max(env(safe-area-inset-top, 0px), 44px)",
  );
  assert.equal(
    properties.get("--app-content-safe-top"),
    "max(var(--app-safe-top), 32px)",
  );
  assert.equal(
    properties.get("--app-workspace-safe-top"),
    "calc(var(--app-content-safe-top) + 40px)",
  );
  assert.equal(root.dataset.telegramFullscreen, "true");
  syncHostViewport(root);
  assert.equal(root.dataset.telegramFullscreen, "false");
  assert.equal(
    properties.get("--app-workspace-safe-top"),
    "calc(var(--app-content-safe-top) + 0px)",
  );
});
