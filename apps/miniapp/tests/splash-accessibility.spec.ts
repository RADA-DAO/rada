import { test, expect } from "@playwright/test";
import {
  FROG,
  WON,
  image,
  en,
  launch,
  openSplash,
  round,
} from "./splash-fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.route("**/v1/splash/claims/mine", (route) =>
    route.fulfill({ json: { claims: [] } }),
  );
});

test("results pagination keeps focus while loading and announces the new round heading", async ({
  page,
}) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/v1/splash/round", (route) =>
    route.fulfill({ json: round(0) }),
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
  await page.getByRole("tab", { name: en("splash.resultsTitle") }).click();
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

test("past rounds show the winning amount and archive frogs with no unique bid", async ({
  page,
}) => {
  await page.route("**/v1/splash/round", (route) =>
    route.fulfill({ json: round(0) }),
  );
  await page.route("**/v1/splash/bids/mine", (route) =>
    route.fulfill({ json: { bids: [] } }),
  );
  await page.route("**/v1/splash/rounds/*/results", (route) =>
    route.fulfill({
      json: {
        round_id: 6,
        starts_at: "2026-10-16T00:00:00Z",
        frogs: [
          {
            submission_id: "11111111-1111-4111-8111-111111111111",
            image_path:
              "/v1/splash/submissions/11111111-1111-4111-8111-111111111111/image",
            outcome: "won",
            bidder_count: 4,
            amount: "3000000000",
            name: "Lily",
            winner: null,
            claim_deadline: null,
          },
          {
            submission_id: "22222222-2222-4222-8222-222222222222",
            image_path:
              "/v1/splash/submissions/22222222-2222-4222-8222-222222222222/image",
            outcome: "archived",
            bidder_count: 2,
            amount: null,
            name: null,
            winner: null,
            claim_deadline: null,
          },
        ],
      },
    }),
  );
  await launch(page);
  await openSplash(page);
  await page.getByRole("tab", { name: en("splash.resultsTitle") }).click();
  const rows = page.getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByText("3 JPEGPE")).toBeVisible();
  await expect(rows.nth(0).getByText(en("splash.anonymous"))).toBeVisible();
  await expect(rows.nth(0).getByText("4", { exact: true })).toBeVisible();
  await expect(rows.nth(1).getByText(en("splash.archived"))).toBeVisible();
  await expect(rows.nth(1).getByText("2", { exact: true })).toBeVisible();
  await expect(rows.nth(1).getByText(en("splash.winningBid"))).toHaveCount(0);
});

test("next-round bench excludes live frogs and tabs retain keyboard focus", async ({
  page,
}) => {
  await page.route("**/v1/splash/round", (route) =>
    route.fulfill({ json: round(0) }),
  );
  await page.route("**/v1/splash/bids/mine", (route) =>
    route.fulfill({ json: { bids: [] } }),
  );
  await launch(page);
  await page.route("**/v1/splash/submissions/mine", (route) =>
    route.fulfill({
      json: {
        submissions: [FROG, WON].map((id) => ({
          submission_id: id,
          state: "in_pond",
          image_path: image(id),
        })),
      },
    }),
  );
  await openSplash(page);
  const rules = page.getByRole("button", {
    name: en("splash.rules"),
    exact: true,
  });
  await rules.click();
  const sheet = page.getByRole("dialog", { name: en("splash.rules") });
  await expect(sheet.getByText(en("splash.bidRule"))).toBeVisible();
  await expect(sheet.getByText(en("splash.burnRule"))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(rules).toBeFocused();
  const next = page.getByRole("tab", {
    name: en("splash.nextTab"),
    exact: true,
  });
  await next.focus();
  await page.keyboard.press("Enter");
  await expect(next).toBeFocused();
  const queue = page.getByRole("list", { name: en("splash.queueTitle") });
  await expect(queue.getByRole("listitem")).toHaveCount(1);
  await expect(queue.getByRole("img")).toHaveAttribute("src", new RegExp(WON));
  await page
    .getByRole("button", { name: en("splash.submitTitle"), exact: true })
    .click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("tab", { name: en("splash.nextTab"), exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
