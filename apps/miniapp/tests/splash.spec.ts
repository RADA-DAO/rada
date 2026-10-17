import { test, expect, type Route } from "@playwright/test";
import { t } from "../../../packages/i18n/src/index.ts";
import {
  FROG,
  WON,
  INTENT,
  sender,
  recipient,
  en,
  image,
  png,
  launch,
  openSplash,
  round,
} from "./splash-fixture.ts";

// Defaults; a test's own routes, registered later, take precedence.
test.beforeEach(async ({ page }) => {
  await page.route("**/v1/splash/round", (route) =>
    route.fulfill({ json: { round: null } }),
  );
});
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, json: body });

test("browse the round, place a bid with a live name check, then raise it", async ({
  page,
}) => {
  const placed: unknown[] = [];
  let mine: unknown[] = [];
  await page.route("**/v1/splash/round", (route) =>
    json(route, placed.length ? round("2000000000", 1) : round(null, 0)),
  );
  await page.route("**/v1/splash/bids/mine", (route) =>
    json(route, { bids: mine }),
  );
  await page.route("**/v1/splash/names/*", (route) => {
    const name = decodeURIComponent(
      route.request().url().split("/").pop() ?? "",
    );
    return json(route, {
      name,
      status: name.toLowerCase() === "taken" ? "taken" : "available",
    });
  });
  await page.route("**/v1/splash/bids", async (route) => {
    const body = route.request().postDataJSON() as Record<string, string>;
    placed.push(body);
    mine = [
      {
        round_id: 7,
        submission_id: FROG,
        amount: body.amount,
        name: body.name,
        placed_at: "2026-10-16T01:00:00.000Z",
        round_ends_at: "2026-10-17T00:00:00.000Z",
        status: "active",
        granted_name: null,
        name_outcome: null,
        claim_deadline: null,
      },
    ];
    await json(route, { bid_id: "1", name_contested: false }, 201);
  });
  await launch(page);
  await openSplash(page);
  await expect(
    page.getByText(en("splash.roundTitle", { round: "7" })),
  ).toBeVisible();
  await expect(page.getByRole("timer")).toHaveText(/^\d\d:\d\d:\d\d$/);
  await expect(
    page.getByRole("img", {
      name: en("splash.frogByAlt", { author: "Painter" }),
    }),
  ).toBeVisible();
  await expect(page.getByText(en("splash.noBids"))).toBeVisible();

  await page
    .getByRole("button", {
      name: en("splash.bidFor", { author: `Painter · ${FROG}` }),
    })
    .click();
  const sheet = page.getByRole("dialog", { name: en("splash.bidTitle") });
  await expect(sheet.getByText(en("splash.promise"))).toBeVisible();
  await expect(sheet.getByText(en("splash.burnRule"))).toBeVisible();
  await sheet.getByLabel(en("splash.bidAmountLabel")).fill("2");
  const name = sheet.getByLabel(en("splash.nameLabel"));
  await name.fill("1frog");
  await sheet.getByRole("button", { name: en("splash.placeBid") }).click();
  await expect(sheet.getByRole("alert")).toHaveText(
    en("splash.error.invalid_name"),
  );
  await expect(name).toBeFocused();
  await name.fill("Taken");
  await expect(sheet.getByText(en("splash.nameTaken"))).toBeVisible();
  await sheet.getByRole("button", { name: en("splash.placeBid") }).click();
  await expect(sheet.getByRole("alert")).toHaveText(
    en("splash.error.name_taken"),
  );
  await name.fill("Lily_1");
  await expect(sheet.getByText(en("splash.nameAvailable"))).toBeVisible();
  await sheet.getByRole("button", { name: en("splash.placeBid") }).click();
  await expect(sheet).toHaveCount(0);
  expect(placed).toEqual([
    { submission_id: FROG, amount: "2000000000", name: "Lily_1" },
  ]);
  await expect(page.getByText(en("splash.bidPlaced"))).toBeVisible();
  await expect(page.getByText(en("splash.youAtTop"))).toBeVisible();

  // Raise: Escape closes the sheet without placing anything, then raise for real.
  const raise = page.getByRole("button", {
    name: en("splash.raiseBidFor", { author: `Painter · ${FROG}` }),
  });
  await expect(raise).toBeFocused();
  await raise.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(raise).toBeFocused();
  await raise.click();
  const again = page.getByRole("dialog", { name: en("splash.raiseTitle") });
  await again.getByLabel(en("splash.bidAmountLabel")).fill("2,5");
  await again.getByRole("button", { name: en("splash.raiseBid") }).click();
  await expect(again).toHaveCount(0);
  expect(placed[1]).toEqual({
    submission_id: FROG,
    amount: "2500000000",
    name: "Lily_1",
  });

  // Back (here Escape, which follows the same stack) returns home.
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
});

test("submit a frog: preview, stored result and the rate limit", async ({
  page,
}) => {
  let uploads = 0;
  await page.route("**/v1/splash/round", (route) =>
    json(route, { round: null }),
  );
  await page.route("**/v1/splash/bids/mine", (route) =>
    json(route, { bids: [] }),
  );
  await page.route("**/v1/splash/submissions", async (route) => {
    uploads++;
    expect(route.request().headers()["content-type"]).toBe("image/png");
    if (uploads > 1) {
      await route.fulfill({
        status: 429,
        headers: {
          "Retry-After": "600",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Expose-Headers": "Retry-After",
        },
        json: { error: "rate_limited" },
      });
      return;
    }
    await json(
      route,
      {
        submission_id: FROG,
        state: "in_pond",
        width: 96,
        height: 96,
        background_removed: true,
        image_path: image(FROG),
      },
      201,
    );
  });
  await launch(page);
  await openSplash(page);
  await expect(page.getByText(en("splash.noRound"))).toBeVisible();
  await page.getByRole("button", { name: en("splash.submitTitle") }).click();
  await expect(
    page.getByRole("heading", { name: en("splash.submitTitle"), exact: true }),
  ).toBeVisible();
  const file = page.getByLabel(en("splash.pickImage"));
  await file.setInputFiles({
    name: "frog.png",
    mimeType: "image/png",
    buffer: png(),
  });
  await expect(
    page.getByRole("img", { name: en("splash.previewAlt") }),
  ).toBeVisible();
  await page.getByRole("button", { name: en("splash.upload") }).click();
  await expect(page.getByText(en("splash.submitted"))).toBeVisible();
  await expect(
    page.getByRole("img", { name: en("splash.resultAlt") }),
  ).toBeVisible();
  await expect(page.getByText(en("splash.backgroundRemoved"))).toBeVisible();

  await file.setInputFiles({
    name: "frog.png",
    mimeType: "image/png",
    buffer: png(80),
  });
  await page.getByRole("button", { name: en("splash.upload") }).click();
  await expect(
    page.getByText(en("splash.error.rate_limited", { minutes: "10" })),
  ).toBeVisible();
});

const claimOf = (state: string, payment: unknown = null) => ({
  submission_id: WON,
  round_id: 6,
  amount: "3000000000",
  name: "Lily_1",
  name_outcome: "reserved",
  claim_deadline: new Date(Date.now() + 20 * 3_600_000).toISOString(),
  state,
  frog: null,
  payment,
});

test("claim a win through the platform payment window", async ({ page }) => {
  let paid = false;
  let started: unknown;
  const intent = () => ({
    intentId: INTENT,
    status: paid ? "paid" : "prepared",
    token: "JPEGPE",
    amount: "3000000000",
    recipient,
    sender,
    purpose: `splash:${WON}`,
    network: "-239",
    gasBudget: "100000000",
    feeEstimate: {
      nano: "1234567",
      expiresAt: Math.floor(Date.now() / 1000) + 120,
    },
  });
  await page.route("**/v1/splash/bids/mine", (route) =>
    json(route, { bids: [] }),
  );
  await page.route("**/v1/splash/claims/mine", (route) =>
    json(route, { claims: [claimOf(paid ? "claimed" : "open")] }),
  );
  await page.route(`**/v1/splash/claims/${WON}`, async (route) => {
    if (route.request().method() === "POST") {
      started = route.request().postDataJSON();
      await json(route, { status: "ready", payment: intent() });
      return;
    }
    await json(route, { claim: claimOf(paid ? "claimed" : "open") });
  });
  await page.route("**/me/payments/**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("appId")).toBe("splash");
    if (url.pathname.endsWith("/claim")) {
      paid = true;
      await json(route, {
        payment: { ...intent(), status: "unknown" },
        signRequest: {
          network: "-239",
          from: sender,
          validUntil: Math.floor(Date.now() / 1000) + 60,
          messages: [{ address: recipient, amount: "1", payload: "synthetic" }],
        },
      });
      return;
    }
    await json(route, { payment: intent() });
  });
  await launch(page, true);
  await openSplash(page);
  await page.getByRole("button", { name: en("splash.mineTitle") }).click();
  await expect(
    page.getByText(en("splash.state.open"), { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: en("splash.claim") }).click();
  const sheet = page.getByRole("dialog", { name: en("splash.claimTitle") });
  await expect(sheet.getByText(en("splash.claimExplain"))).toBeVisible();
  await sheet
    .getByRole("button", { name: en("splash.continueToPayment") })
    .click();
  const window = page.getByRole("dialog", { name: t("en", "payment.title") });
  await expect(window.getByText("3 JPEGPE")).toBeVisible();
  await window
    .getByRole("button", { name: t("en", "payment.confirm") })
    .click();
  await expect(page.getByText(en("splash.claimDone"))).toBeVisible();
  await expect(
    page.getByText(en("splash.state.claimed"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: en("splash.mineTitle"), exact: true }),
  ).toBeFocused();
  expect(started).toEqual({ sender });
  expect(
    await page.evaluate(() => localStorage.getItem("fixture-ton-sends")),
  ).toBe("1");
});

test("burned and unconfirmed wins are shown honestly", async ({ page }) => {
  await page.route("**/v1/splash/bids/mine", (route) =>
    json(route, { bids: [] }),
  );
  await page.route("**/v1/splash/claims/mine", (route) =>
    json(route, {
      claims: [
        claimOf("burned", { intent_id: INTENT, status: "cancelled" }),
        {
          ...claimOf("open", { intent_id: INTENT, status: "unknown" }),
          submission_id: FROG,
          name: null,
        },
      ],
    }),
  );
  await launch(page);
  await openSplash(page);
  await page.getByRole("button", { name: en("splash.mineTitle") }).click();
  await expect(
    page.getByText(en("splash.state.burned"), { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(en("splash.state.burnedNote"))).toBeVisible();
  await expect(
    page.getByText(en("splash.state.confirming"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: en("splash.claim") }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: en("splash.checkAgain") }),
  ).toBeVisible();
});
