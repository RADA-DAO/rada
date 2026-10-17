import { test, expect, type Page } from "@playwright/test";

import { catalogContrast } from "./test/contrast.ts";

const themes = ["guest", "light", "dark"] as const;
const artworkPath = `/media/jpegpe/${"a".repeat(64)}.png`;
// A fixed 16x16 PNG so the frog card artwork never depends on a network.
const artwork = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAABlklEQVR4nA3LQQEAIQgAQSMQwQhEIIIRjEAEIhjBCETguU8jGMEId/Of1hrS6A1tWGM0ZsMb0ViN3chGNU7jNl6jNUGELqhgwhCm4EIIS9hCCiUc4QpP/tCRTu9oxzqjMzveic7q7E52qnM6t/P6HxRRuqKKKUOZiiuhLGUrqZRylKs8/YMhRjfUMGMY03AjjGVsI40yjnGNZ38YyKAPdGCDMZgDH8RgDfYgBzU4gzt44w8TmfSJTmwyJnPik5isyZ7kpCZncidv/sERpzvqmDOc6bgTznK2k045x7nO8z8EEvRAAwtGMAMPIljBDjKo4AQ3ePGHhSz6Qhe2GIu58EUs1mIvclGLs7iLt/6wkU3f6MY2YzM3vonN2uxNbmpzNnfz9h8SSXqiiSUjmYknkaxkJ5lUcpKbvPxDIUUvtLBiFLPwIopV7CKLKk5xi1d/OMihH/Rgh3GYBz/EYR32IQ91OId7eOcPF7n0i17sMi7z4pe4rMu+5KUu53Iv7/7hIY/+0Ic9xmM+/BGP9diPfNTjPO7jPT6GdLgQ6NhxmQAAAABJRU5ErkJggg==",
  "base64",
);

async function open(page: Page, query: string) {
  await page.route(`**${artworkPath}`, (route) =>
    route.fulfill({ body: artwork, contentType: "image/png" }),
  );
  await page.goto(`/catalog.html?${query}`);
  await page.locator("html[data-catalog-ready]").waitFor();
  await page.evaluate(() => document.fonts.ready);
  // Full-page fixtures must load artwork even when new catalog sections move it offscreen.
  await page.evaluate(() => {
    for (const image of document.images) image.loading = "eager";
  });
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete),
  );
  // Two frames so layout and paint settle before the capture.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

for (const theme of themes) {
  test(`catalog, ${theme} theme`, async ({ page }) => {
    await open(page, `theme=${theme}`);
    // The shell scrolls inside a fixed-height surface; let it grow so one image shows everything.
    await page.addStyleTag({
      content:
        "html,body{overflow:visible!important}.screen-wrap,.screen{height:auto!important;overflow:visible!important}",
    });
    await expect(page).toHaveScreenshot(`catalog-${theme}.png`, {
      fullPage: true,
    });
  });
}

for (const theme of themes) {
  test(`painted text contrast, ${theme} theme`, async ({ page }) => {
    test.setTimeout(120_000);
    await open(page, `theme=${theme}`);
    if (theme === "light") {
      // This fixture authors #2B6CB0; all solid accent controls must preserve it.
      for (const control of [
        page.getByRole("button", { name: "Primary", exact: true }),
        page.getByText("Claimed", { exact: true }),
        page.locator(".rada-avatar").nth(1),
      ])
        await expect(control).toHaveCSS(
          "background-color",
          "rgb(43, 108, 176)",
        );
    }
    const background = await page.context().newPage();
    await open(background, `theme=${theme}`);
    for (const expanded of [false, true]) {
      if (expanded)
        for (const surface of [page, background])
          await surface.addStyleTag({
            content:
              "html,body{overflow:visible!important}.screen-wrap,.screen{height:auto!important;overflow:visible!important}",
          });
      const result = await catalogContrast(page, background);
      expect(result.sampled).toBeGreaterThan(60);
      expect(
        result.failures,
        expanded ? "full page" : "shell scroller",
      ).toEqual([]);
    }
  });
}

for (const theme of themes) {
  test(`open sheet, ${theme} theme`, async ({ page }) => {
    await open(page, `theme=${theme}&sheet=open`);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveScreenshot(`sheet-${theme}.png`);
  });
}

// The standard's phone widths catch overflow and shrunken controls independently
// of the fixed screenshot sizes. Neutral and close hues exercise fallback roles.
test("workspace geometry and bundled fonts", async ({ page }) => {
  for (const theme of [...themes, "neutral", "close"]) {
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await open(page, `theme=${theme}`);
      const layout = await page.evaluate(() => {
        const screen = document.querySelector<HTMLElement>(".screen");
        if (!screen) throw new Error("Missing screen");
        const buttons = [...document.querySelectorAll<HTMLElement>("button")];
        return {
          overflow: screen.scrollWidth > screen.clientWidth,
          controlsFit: buttons.every((button) => {
            const rect = button.getBoundingClientRect();
            return (
              rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44
            );
          }),
          fonts: ["Onest", "Outfit", "Sora", "Unbounded"].every((font) =>
            document.fonts.check(`700 16px ${font}`),
          ),
        };
      });
      expect(layout, `${theme} at ${String(width)}px`).toEqual({
        overflow: false,
        controlsFit: true,
        fonts: true,
      });
    }
  }
});
