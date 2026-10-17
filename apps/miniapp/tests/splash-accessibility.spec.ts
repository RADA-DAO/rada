import { test, expect } from "@playwright/test";
import { en, launch, openSplash, round } from "./splash-fixture.ts";

test("results pagination keeps focus while loading and announces the new round heading", async ({
  page,
}) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/splash/round", (route) =>
    route.fulfill({ json: round(null, 0) }),
  );
  await page.route("**/v1/splash/bids/mine", (route) =>
    route.fulfill({ json: { bids: [] } }),
  );
  await page.route("**/v1/splash/rounds/*/results", async (route) => {
    const id = Number(route.request().url().split("/").at(-2));
    if (id === 5) await waiting;
    await route.fulfill({
      json: { round_id: id, starts_at: "2026-10-16T00:00:00Z", frogs: [] },
    });
  });
  await launch(page);
  await openSplash(page);
  await expect(
    page.getByRole("heading", { name: en("splash.title"), exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: en("splash.resultsTitle") }).click();
  const older = page.getByRole("button", { name: en("splash.olderRound") });
  await older.focus();
  await page.keyboard.press("Enter");
  await expect(older).toBeFocused();
  release();
  await expect(page.getByRole("heading", { name: /^Round 5/ })).toBeFocused();
  await page.getByRole("button", { name: en("splash.newerRound") }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /^Round 6/ })).toBeFocused();
});
