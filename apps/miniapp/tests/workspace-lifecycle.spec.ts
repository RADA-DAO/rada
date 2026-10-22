import { test, expect } from "@playwright/test";
import { launch, ownProfile } from "./home-fixture.ts";

test("late launcher data preserves the collection detail and its selection action", async ({
  page,
}) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frog = {
    frog_id: "00000000-0000-4000-8000-000000000011",
    username: "Fixture_frog",
    background_color: null,
    accent_color: null,
    artwork_path: null,
  };
  await page.route("**/apps/published", async (route) => {
    await waiting;
    await route.fulfill({ json: { apps: [] } });
  });
  await page.route("**/me", (route) =>
    route.fulfill({
      json: ownProfile({ visibility: "private", public: null }),
    }),
  );
  await page.route("**/apps/review-queue", (route) =>
    route.fulfill({ status: 403, json: { error: "forbidden" } }),
  );
  for (const path of ["me/wallet", "me/wallet/balances"])
    await page.route(`**/${path}`, (route) =>
      route.fulfill({ json: { wallets: [] } }),
    );
  let reads = 0;
  await page.route("**/me/frogs", (route) => {
    reads++;
    return route.fulfill({ json: { frogs: [frog] } });
  });
  await page.route(`**/me/frogs/${frog.frog_id}`, (route) =>
    route.fulfill({
      json: {
        creator: null,
        owner: null,
        colour_source: "legacy_unverified",
        history: [],
      },
    }),
  );
  await launch(page);
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page
    .getByRole("button", { name: "Open collection", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open FIXTURE_FROG", exact: true })
    .click();
  const select = page.getByRole("button", {
    name: "Use FIXTURE_FROG",
    exact: true,
  });
  await expect(select).toBeVisible();
  await expect(page.locator(".screen > .rada-screen-view")).toHaveCount(1);
  await expect(page.locator(".screen > .rada-workspace-track")).toHaveCount(0);
  const before = reads;
  await select.evaluate((node) => {
    node.setAttribute("data-lifecycle-probe", "kept");
  });
  const response = page.waitForResponse("**/apps/published");
  release();
  await response;
  // Drain the response and rendering tasks without depending on a fixed delay.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(select).toHaveAttribute("data-lifecycle-probe", "kept");
  expect(reads).toBe(before);
  await expect(select).toBeEnabled();
  await select.scrollIntoViewIfNeeded();
  await expect(select).toBeInViewport();
});
