import type { Page } from "@playwright/test";

/** Sample the painted pixels with glyphs removed, preserving layout, gradients,
 * glass layers, images and shadows. Computed ancestor colours alone cannot do this. */
type Sample = { text: string; color: number[]; points: number[][] };

export async function catalogContrast(page: Page, backgroundPage: Page) {
  // Keep foreground styles untouched; mask an identically rendered second page.
  // Mutating inherited colour on the measured page can leave stale browser styles.
  const mask = await backgroundPage.addStyleTag({
    content:
      ".screen,.screen *{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;caret-color:transparent!important}",
  });
  const failures: string[] = [];
  const allSamples: Sample[] = [];
  const measured: { text: string; ratio: number }[] = [];
  const seen = new Set<string>();
  const extent = await page.locator(".screen").evaluate((screen) => ({
    height: screen.scrollHeight,
    viewport: screen.clientHeight,
  }));
  const fullPage = extent.height <= extent.viewport;
  const height = fullPage
    ? await page.evaluate(() => document.documentElement.scrollHeight)
    : extent.height;
  const viewport = await page.evaluate(() => innerHeight);
  for (let y = 0; y < height; y += Math.floor(viewport / 2)) {
    for (const surface of [page, backgroundPage]) {
      // WebKit throttles painting in background tabs; scroll each visible surface.
      await surface.bringToFront();
      await surface.evaluate(
        ({ y, fullPage }) => {
          if (fullPage) window.scrollTo(0, y);
          else document.querySelector(".screen")?.scrollTo(0, y);
        },
        { y, fullPage },
      );
    }
    await settle(page);
    await settle(backgroundPage);
    const samples = await page.evaluate((fullPage) => {
      const result: { text: string; color: number[]; points: number[][] }[] =
        [];
      const walker = document.createTreeWalker(
        document.querySelector(".screen") ?? document.body,
        NodeFilter.SHOW_TEXT,
      );
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent) continue;
        if (
          !node.textContent?.trim() ||
          parent.closest("option,textarea,.rada-visually-hidden")
        )
          continue;
        // Sticky/fixed text is covered in the native scroller pass. Its viewport
        // coordinates cannot be mapped into a single full-page bitmap.
        if (fullPage) {
          let pinned = false;
          for (let el: Element | null = parent; el; el = el.parentElement)
            if (["sticky", "fixed"].includes(getComputedStyle(el).position))
              pinned = true;
          if (pinned) continue;
        }
        const style = getComputedStyle(parent);
        if (style.visibility !== "visible" || style.display === "none")
          continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (
            rect.width < 2 ||
            rect.height < 2 ||
            rect.top < 0 ||
            rect.bottom > innerHeight
          )
            continue;
          const points: number[][] = [];
          for (const fx of [0.15, 0.5, 0.85]) {
            for (const fy of [0.25, 0.5, 0.75]) {
              const x = rect.left + rect.width * fx;
              const y = rect.top + rect.height * fy;
              const hit = document.elementFromPoint(x, y);
              if (
                hit === parent ||
                (hit && parent.contains(hit) && hit.tagName !== "IMG")
              )
                points.push([Math.floor(x), Math.floor(y)]);
            }
          }
          if (!points.length) continue;
          const color = (style.color.match(/[\d.]+/g) ?? []).map(Number);
          let opacity = 1;
          for (
            let element: Element | null = parent;
            element;
            element = element.parentElement
          )
            opacity *= Number(getComputedStyle(element).opacity);
          color[3] = (color[3] ?? 1) * opacity;
          const state = parent.closest(":disabled")
            ? "disabled"
            : parent.closest(".rada-badge")
              ? "chip"
              : parent.closest(":focus-visible")
                ? "focus"
                : parent.closest("button:hover")
                  ? "hover"
                  : "default";
          result.push({
            text: `${state}: ${node.textContent.trim()}`,
            color,
            points,
          });
        }
      }
      // Native form values are painted text but do not expose text-node ranges.
      for (const field of document.querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >(".rada-field-control")) {
        const rect = field.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > innerHeight) continue;
        const style = getComputedStyle(field);
        // Native select glyphs may ignore text-fill masking. Its field surface
        // is uniform; sample inside the same content box beyond the value.
        const x = rect.right - parseFloat(style.paddingRight) - 35;
        const y =
          rect.top +
          parseFloat(style.paddingTop) +
          parseFloat(style.fontSize) / 2;
        if (document.elementFromPoint(x, y) !== field) continue;
        result.push({
          text: field.value,
          color: (style.color.match(/[\d.]+/g) ?? []).map(Number),
          points: [[Math.floor(x), Math.floor(y)]],
        });
      }
      return result;
    }, fullPage);
    if (fullPage) {
      const scrollY = await page.evaluate(() => window.scrollY);
      for (const sample of samples)
        for (const point of sample.points) point[1] = (point[1] ?? 0) + scrollY;
      allSamples.push(...samples);
    } else
      measured.push(...(await measure(page, backgroundPage, samples, false)));
  }
  if (fullPage) {
    for (const surface of [page, backgroundPage]) {
      // WebKit throttles painting in background tabs; scroll each visible surface.
      await surface.bringToFront();
      await surface.evaluate(() => {
        window.scrollTo(0, 0);
      });
    }
    await settle(page);
    measured.push(...(await measure(page, backgroundPage, allSamples, true)));
  }
  for (const { text, ratio } of measured) {
    seen.add(text);
    if (ratio < 4.5) failures.push(`${text}: ${ratio.toFixed(2)}:1`);
  }
  await mask.evaluate((element) => element.parentNode?.removeChild(element));
  return {
    failures: [...new Set(failures)],
    sampled: seen.size,
    states: [...seen].map((text) => text.split(":")[0]),
  };
}

async function measure(
  page: Page,
  backgroundPage: Page,
  samples: Sample[],
  fullPage: boolean,
) {
  await settle(backgroundPage);
  const background = (await backgroundPage.screenshot({ fullPage })).toString(
    "base64",
  );
  // WebKit can suspend image decoding in the background measurement tab.
  await page.bringToFront();
  return await page.evaluate(
    async ({ background, samples }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${background}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, 0, 0);
      const luminance = (rgb: number[]) =>
        rgb.slice(0, 3).reduce((sum, value, i) => {
          const c = value / 255;
          return (
            sum +
            (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
              ([0.2126, 0.7152, 0.0722][i] ?? 0)
          );
        }, 0);
      return samples.map(({ text, color, points }) => {
        const ratios = points.map(([x, y]) => {
          const bg = [...context.getImageData(x ?? 0, y ?? 0, 1, 1).data];
          const fg = color
            .slice(0, 3)
            .map(
              (c, i) =>
                c * (color[3] ?? 1) + (bg[i] ?? 0) * (1 - (color[3] ?? 1)),
            );
          const a = luminance(bg),
            b = luminance(fg);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        });
        return { text, ratio: Math.min(...ratios) };
      });
    },
    { background, samples },
  );
}

async function settle(page: Page) {
  await page.bringToFront();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            resolve();
          }),
        ),
      ),
  );
}
