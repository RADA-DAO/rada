import { test, expect } from "@playwright/test";
import {
  applyPalette,
  child,
  emitHost,
  nativeBack,
  openExample,
  readUiContext,
  withExample,
} from "./ui-sdk-fixture.ts";

test("current UI theme, responsive geometry and live context stay shared", async ({
  page,
}, info) => {
  test.skip(
    !process.env.RADA_LOCAL_API_ORIGIN,
    "Disposable local platform required",
  );
  await withExample(page, info, async () => {
    const draft = child(page).locator("#draft");
    await draft.fill("Shared draft");
    const themes = [
      ["#164E42", null],
      ["#F5ECD9", "#2B6CB0"],
      ["#101B18", "#92E3CC"],
      ["#808080", null],
      ["#476A59", "#496C5B"],
      ["#FFFFFF", "#FFFF00"],
      ["#000000", "#000000"],
    ] as const;
    for (const [background, accent] of themes) {
      const palette = await applyPalette(page, background, accent);
      await expect
        .poll(async () => (await readUiContext(page)).ui.tokens["--theme-base"])
        .toBe(background);
      const context = await readUiContext(page);
      expect(Object.keys(context).sort()).toEqual(["locale", "ui"]);
      expect(context.ui.version).toBe(1);
      expect(context.ui.tokens["--text-primary"]).toBe(
        palette.tokens["--text-primary"],
      );
      expect(context.ui.viewport.width).toBeGreaterThan(0);
      for (const inset of Object.values(context.ui.safeArea))
        expect(inset).toBeGreaterThanOrEqual(0);
      await expect(draft).toHaveValue("Shared draft");
      const geometry = await child(page)
        .locator("body")
        .evaluate((body) => {
          const style = getComputedStyle(body);
          const controls = [...body.querySelectorAll<HTMLElement>("button")]
            .filter(
              (node) =>
                node.getClientRects().length > 0 &&
                getComputedStyle(node).visibility !== "hidden",
            )
            .map((node) => ({
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
              font: getComputedStyle(node).fontFamily,
            }));
          const field = body.querySelector<HTMLElement>("#draft");
          return {
            font: style.fontFamily,
            overflow: document.documentElement.scrollWidth - innerWidth,
            fieldSize: field
              ? Number.parseFloat(getComputedStyle(field).fontSize)
              : 0,
            controls,
          };
        });
      expect(geometry.font).toContain("-apple-system");
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.fieldSize).toBeGreaterThanOrEqual(16);
      expect(geometry.controls.length).toBeGreaterThanOrEqual(3);
      for (const control of geometry.controls) {
        expect(control.height).toBeGreaterThanOrEqual(44);
        expect(control.width).toBeGreaterThanOrEqual(44);
        expect(control.font).toContain("-apple-system");
      }
    }
    await draft.focus();
    await draft.evaluate((node) => {
      (node as HTMLInputElement).setSelectionRange(2, 8);
    });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "125%";
    });
    await expect
      .poll(async () => (await readUiContext(page)).ui.rootFontSize)
      .toBe(20);
    const nativeSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.body).fontSize),
    );
    expect(nativeSize).toBeCloseTo(21.25, 2);
    await expect
      .poll(() =>
        child(page)
          .locator("body")
          .evaluate((node) =>
            Number.parseFloat(getComputedStyle(node).fontSize),
          ),
      )
      .toBeCloseTo(nativeSize, 2);
    expect(
      await draft.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).fontSize),
      ),
    ).toBeCloseTo(nativeSize, 2);
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("Shared draft");
    expect(
      await draft.evaluate((node) => ({
        start: (node as HTMLInputElement).selectionStart,
        end: (node as HTMLInputElement).selectionEnd,
      })),
    ).toEqual({ start: 2, end: 8 });
    expect(
      await child(page)
        .locator("body")
        .evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "16px";
    });
    await expect
      .poll(async () => (await readUiContext(page)).ui.rootFontSize)
      .toBe(16);
    await emitHost(page, "safeAreaChanged", {
      safeAreaInset: { top: 47, right: 0, bottom: 34, left: 0 },
      contentSafeAreaInset: { top: 46, right: 0, bottom: 0, left: 0 },
    });
    await expect
      .poll(async () => (await readUiContext(page)).ui.safeArea.top)
      .toBe(0);
    // The shell consumes header clearance: the child must not add it a second time.
    const frameBox = await page
      .locator("iframe[sandbox='allow-scripts']")
      .boundingBox();
    expect(frameBox).not.toBeNull();
    expect(frameBox?.y ?? 0).toBeGreaterThanOrEqual(47);
    const rootScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    );
    expect(rootScroll).toBeLessThanOrEqual(1);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(async () => (await readUiContext(page)).ui.reducedMotion)
      .toBe(true);
    await page.screenshot({ path: info.outputPath("shared-ui-context.png") });
  });
});

test("keyboard overlay and resized layouts preserve focused drafts and modal access", async ({
  page,
}, info) => {
  test.skip(
    !process.env.RADA_LOCAL_API_ORIGIN,
    "Disposable local platform required",
  );
  await withExample(page, info, async () => {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Viewport required");
    const draft = child(page).locator("#draft");
    await draft.fill("Keep this draft");
    await draft.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await expect(draft).toBeFocused();
    await draft.press("Enter");
    await expect(draft).not.toBeFocused();
    await expect(draft).toHaveValue("Keep this draft");
    await draft.focus();
    await draft.evaluate((node) => {
      (node as HTMLInputElement).setSelectionRange(4, 9);
    });
    const before = await draft.evaluate((node) => ({
      start: (node as HTMLInputElement).selectionStart,
      end: (node as HTMLInputElement).selectionEnd,
    }));
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
      dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    await child(page)
      .locator("body")
      .evaluate(() => {
        dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
    await applyPalette(page, "#476A59", "#496C5B");
    await expect
      .poll(async () => (await readUiContext(page)).ui.tokens["--theme-base"])
      .toBe("#476A59");
    await expect(draft).toBeFocused();
    await expect(draft).toHaveValue("Keep this draft");
    const beforeKeyboard = (await readUiContext(page)).ui.viewport
      .visibleHeight;
    const visible = Math.max(380, viewport.height - 300);
    await emitHost(page, "viewportChanged", { viewportHeight: visible });
    await expect
      .poll(async () => (await readUiContext(page)).ui.viewport.visibleHeight)
      .toBeLessThan(beforeKeyboard);
    await expect(draft).toHaveValue("Keep this draft");
    expect(
      await draft.evaluate((node) => ({
        start: (node as HTMLInputElement).selectionStart,
        end: (node as HTMLInputElement).selectionEnd,
      })),
    ).toEqual(before);
    await expect(draft).toBeFocused();
    await emitHost(page, "viewportChanged", {
      viewportHeight: viewport.height,
    });
    await child(page).locator("#open-details").click();
    const dialog = child(page).locator("dialog#details");
    const quantity = child(page).locator("#quantity");
    await expect(dialog).toBeVisible();
    await quantity.fill("42");
    await emitHost(page, "viewportChanged", { viewportHeight: visible });
    await page.setViewportSize({ width: viewport.width, height: visible });
    await expect(quantity).toHaveValue("42");
    await expect(quantity).toBeFocused();
    // A child viewport must actually shrink: a legacy iframe minimum height can
    // clip correct child dialogs even when their own CSS bounds look valid.
    await expect
      .poll(() =>
        page.locator("iframe[sandbox='allow-scripts']").evaluate((node) => {
          const r = node.getBoundingClientRect();
          const visibleHeight = Math.min(
            innerHeight,
            visualViewport?.height ?? innerHeight,
          );
          return Math.max(
            -r.top,
            r.bottom - visibleHeight,
            -r.left,
            r.right - innerWidth,
          );
        }),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(async () => {
        const context = await readUiContext(page);
        const height = await child(page)
          .locator("body")
          .evaluate(() => innerHeight);
        return Math.abs(context.ui.viewport.height - height);
      })
      .toBeLessThanOrEqual(1);
    // Opening motion and iframe resize settle asynchronously; the final dialog
    // must fit the real child viewport rather than relying on an arbitrary delay.
    await expect
      .poll(() =>
        dialog.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return Math.max(-r.top, r.bottom - innerHeight);
        }),
      )
      .toBeLessThanOrEqual(1);
    const bounded = await dialog.evaluate((node) => {
      const r = node.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(bounded.top).toBeGreaterThanOrEqual(-1);
    expect(bounded.bottom).toBeLessThanOrEqual(bounded.height + 1);
    expect(bounded.overflow).toBeLessThanOrEqual(1);
    const done = child(page).locator(".rada-keyboard-done");
    await expect(done).toHaveCount(1);
    await done.click();
    await expect(quantity).not.toBeFocused();
    await expect(quantity).toHaveValue("42");
    await nativeBack(page);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(
      1,
    );
    await expect(draft).toHaveValue("Keep this draft");
    await expect(child(page).locator("#open-details")).toBeFocused();
    await page.setViewportSize(viewport);
    await emitHost(page, "viewportChanged", {
      viewportHeight: viewport.height,
    });
    await child(page).locator("#open-details").click();
    await expect(dialog).toBeVisible();
    await quantity.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(
      1,
    );
    await expect(draft).toHaveValue("Keep this draft");
    await page.screenshot({ path: info.outputPath("keyboard-restored.png") });
    // A later final departure must still dispose after earlier cached restores.
    await page.evaluate(() => {
      dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
    });
    await expect(page.locator(".rada-shell-header")).toHaveCount(0);
    await expect(page.locator("[data-rada-ui-probe]")).toHaveCount(0);
  });
});

test("native Back, swipe and repeated reopen dispose the app without accumulating host listeners", async ({
  page,
}, info) => {
  test.skip(
    !process.env.RADA_LOCAL_API_ORIGIN,
    "Disposable local platform required",
  );
  await withExample(page, info, async () => {
    await emitHost(page, "fullscreenChanged", {
      isFullscreen: true,
      safeAreaInset: { top: 47, right: 0, bottom: 34, left: 0 },
      contentSafeAreaInset: { top: 46, right: 0, bottom: 0, left: 0 },
    });
    const header = page.locator(".rada-shell-header");
    await expect(header).toHaveCount(1);
    const reference = await header.boundingBox();
    if (!reference) throw new Error("Shared OS header required");
    const viewportWidth = page.viewportSize()?.width ?? 0;
    expect(reference.x).toBeGreaterThanOrEqual(71);
    expect(reference.x + reference.width).toBeLessThanOrEqual(
      viewportWidth - 71,
    );
    expect(reference.x + reference.width / 2).toBeCloseTo(viewportWidth / 2, 0);
    expect(reference.y).toBeGreaterThanOrEqual(47);
    const stableHeader = async () => {
      await expect(header).toHaveCount(1);
      const current = await header.boundingBox();
      if (!current) throw new Error("Shared OS header disappeared");
      for (const property of ["x", "y", "width", "height"] as const)
        expect(
          Math.abs(current[property] - reference[property]),
        ).toBeLessThanOrEqual(1);
    };
    await nativeBack(page);
    await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(
      0,
    );
    const listeners = () =>
      page.evaluate(() =>
        (
          window as unknown as { radaLocalHost: { listeners(): number } }
        ).radaLocalHost.listeners(),
      );
    const baseline = await listeners();
    await expect(page.locator("[data-rada-ui-probe]")).toHaveCount(0);
    await stableHeader();
    for (const iteration of [1, 2, 3]) {
      await openExample(page);
      await expect(page.locator("[data-rada-ui-probe]")).toHaveCount(1);
      await child(page)
        .locator("#draft")
        .fill(`Draft ${String(iteration)}`);
      await child(page).locator("#open-details").click();
      await nativeBack(page);
      await expect(child(page).locator("dialog#details")).not.toBeVisible();
      await nativeBack(page);
      await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(
        0,
      );
      expect(await listeners()).toBe(baseline);
      await expect(page.locator("[data-rada-ui-probe]")).toHaveCount(0);
      await stableHeader();
    }
    await openExample(page);
    // The trusted shell owns horizontal Back, including when an opaque frame is mounted.
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Viewport required");
    const screen = await page.locator(".screen").boundingBox();
    if (!screen) throw new Error("Trusted shell viewport required");
    const startX = screen.x + 4;
    const startY = Math.min(screen.y + screen.height / 2, viewport.height - 64);
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + screen.width * 0.65, startY + 2, {
      steps: 12,
    });
    await stableHeader();
    await page.mouse.up();
    await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(
      0,
    );
    expect(await listeners()).toBe(baseline);
    await stableHeader();
  });
});
