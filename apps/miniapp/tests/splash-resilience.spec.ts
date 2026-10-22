import { test, expect } from "@playwright/test";
import { en, launch, openSplash, png, round } from "./splash-fixture.ts";

for (const [part, path, body] of [
  ["claims", "claims/mine", { claims: [] }],
  ["bids", "bids/mine", { bids: [] }],
  ["submissions", "submissions/mine", { submissions: [] }],
] as const) {
  test(`${part} failure preserves the round and retries inline`, async ({
    page,
  }) => {
    await launch(page);
    await page.route("**/v1/splash/round", (route) =>
      route.fulfill({ json: round(3) }),
    );
    await page.route("**/v1/splash/bids/mine", (route) =>
      route.fulfill({ json: { bids: [] } }),
    );
    await page.route("**/v1/splash/claims/mine", (route) =>
      route.fulfill({ json: { claims: [] } }),
    );
    let failed = true;
    await page.route(`**/v1/splash/${path}`, (route) =>
      route.fulfill(
        failed
          ? { status: 500, json: { error: "unavailable" } }
          : { json: body },
      ),
    );
    await openSplash(page);
    const pond = page.getByRole("list", { name: en("splash.lotsLabel") });
    await expect(pond.getByRole("listitem")).toHaveCount(1);
    await expect(
      page.getByLabel(`${en("splash.bidders")}: 3`, { exact: true }),
    ).toBeVisible();
    const notice = page
      .getByRole("alert")
      .filter({ hasText: en(`splash.loadError.${part}`) });
    await expect(notice).toBeVisible();
    const box = await notice.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error("missing_layout");
    expect(box.x).toBeGreaterThan(0);
    expect(box.x + box.width).toBeLessThan(viewport.width);
    // Claims availability does not block a new bid; unknown ownership does.
    await expect(pond.getByRole("button")).toHaveCount(
      part === "claims" ? 1 : 0,
    );
    failed = false;
    await notice.getByRole("button", { name: en("common.retry") }).click();
    await expect(notice).toHaveCount(0);
    await expect(pond.getByRole("button")).toHaveCount(1);
  });
}

test("a failed history request leaves the live tab available", async ({
  page,
}) => {
  await launch(page);
  await page.route("**/v1/splash/round", (route) =>
    route.fulfill({ json: round(3) }),
  );
  await page.route("**/v1/splash/bids/mine", (route) =>
    route.fulfill({ json: { bids: [] } }),
  );
  await page.route("**/v1/splash/claims/mine", (route) =>
    route.fulfill({ json: { claims: [] } }),
  );
  await page.route("**/v1/splash/rounds/*/results", (route) =>
    route.fulfill({ status: 500, json: { error: "unavailable" } }),
  );
  await openSplash(page);
  const live = page.getByRole("tab", {
    name: en("splash.liveTab"),
    exact: true,
  });
  await live.focus();
  await page.keyboard.press("End");
  await expect(
    page.getByRole("tab", { name: en("splash.resultsTitle"), exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
    en("splash.loadError.history"),
  );
  await page.keyboard.press("Home");
  await expect(live).toBeFocused();
  await expect(live).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("list", { name: en("splash.lotsLabel") }),
  ).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(
    page.getByRole("tab", { name: en("splash.resultsTitle"), exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(live).toBeFocused();
});

for (const artwork of ["opaque", "transparent", "missing"] as const) {
  for (const removed of [false, true]) {
    test(`round card: ${artwork} artwork, background removed ${String(removed)}`, async ({
      page,
    }) => {
      await launch(page);
      const data = round(3);
      const frog = data.round.frogs[0];
      if (!frog) throw new Error("missing_fixture");
      frog.background_removed = removed;
      await page.route("**/v1/splash/round", (route) =>
        route.fulfill({ json: data }),
      );
      await page.route("**/v1/splash/bids/mine", (route) =>
        route.fulfill({ json: { bids: [] } }),
      );
      await page.route("**/v1/splash/claims/mine", (route) =>
        route.fulfill({ json: { claims: [] } }),
      );
      await page.route("**/v1/splash/submissions/*/image", (route) =>
        route.fulfill(
          artwork === "missing"
            ? { status: 404 }
            : {
                body: png(96, artwork === "transparent"),
                contentType: "image/png",
              },
        ),
      );
      await openSplash(page);
      const grid = page.getByRole("list", { name: en("splash.lotsLabel") });
      const lot = grid.getByRole("listitem");
      const card = lot.locator(".jpegpe-card");
      await expect(card).toHaveCount(1);
      await expect(lot).toHaveCSS("border-top-width", "1px");
      await expect(lot).toHaveCSS("border-radius", "24px");
      for (const layer of ["plane", "artwork", "overlay"])
        await expect(card.locator(`.frog-card-${layer}`)).toHaveCSS(
          "mask-image",
          "none",
        );
      if (artwork === "missing")
        await expect(card).toContainText(en("splash.imageMissing"));
      else await expect(card.locator("img")).toBeVisible();
      await expect(lot).toContainText(en("splash.chooseNumber"));
      await expect(
        lot.getByLabel(`${en("splash.bidders")}: 3`, { exact: true }),
      ).toBeVisible();
      const geometry = await grid.evaluate((node) => {
        const item = node.querySelector("li");
        const card = item?.querySelector(".jpegpe-card");
        if (!item || !card) throw new Error("missing_card");
        const itemBox = item.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        return {
          columns: getComputedStyle(node)
            .gridTemplateColumns.split(" ")
            .map(Number.parseFloat),
          gap: getComputedStyle(node).columnGap,
          item: { x: itemBox.x, width: itemBox.width },
          card: { x: cardBox.x, width: cardBox.width },
        };
      });
      expect(geometry.columns).toHaveLength(2);
      const [first, second] = geometry.columns;
      if (first === undefined || second === undefined)
        throw new Error("missing_columns");
      expect(first).toBeCloseTo(second, 0);
      expect(geometry.gap).toBe("12px");
      expect(geometry.card.x - geometry.item.x).toBeCloseTo(17, 0);
      expect(geometry.item.width - geometry.card.width).toBeCloseTo(34, 0);
      await expect(card.locator(".frog-card-username")).toHaveCount(0);
    });
  }
}
