import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
});

test("one shared spacing token updates the screen and navigation", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  const screen = page.locator(".screen");
  const navigation = page.getByRole("navigation");
  await expect(screen).toHaveCSS("padding-top", "16px");
  await expect(navigation).toHaveCSS("gap", "16px");
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--rada-space-4", "24px");
  });
  await expect(screen).toHaveCSS("padding-top", "24px");
  await expect(navigation).toHaveCSS("gap", "24px");
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--rada-z-sheet")
        .trim(),
    ),
  ).toBe("100");
});

test("collectible material tokens retain each frog's own palette", async ({
  page,
}) => {
  const first = {
    frog_id: "00000000-0000-4000-8000-000000000011",
    username: "FixtureDark",
    background_color: "#123456",
    accent_color: "#ABCDEF",
  };
  const second = {
    frog_id: "00000000-0000-4000-8000-000000000012",
    username: "FixtureLight",
    background_color: "#EEEEEE",
    accent_color: "#EDEDED",
  };
  await page.addInitScript(() => {
    if (window !== window.top) return;
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: "synthetic-visual-fixture",
          ready() {},
          expand() {},
          onEvent() {},
          offEvent() {},
          BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
        },
      },
    });
  });
  await page.route("**/me", (route) =>
    route.fulfill({
      json: {
        subject_id: "00000000-0000-4000-8000-000000000101",
        profile: { visibility: "public", public: first },
        membership: { status: "unavailable" },
      },
    }),
  );
  await page.route("**/me/frogs", (route) =>
    route.fulfill({
      json: {
        frogs: [first, second].map((frog) => ({ ...frog, artwork_path: null })),
      },
    }),
  );
  await page.route("**/me/wallet", (route) =>
    route.fulfill({ json: { wallets: [] } }),
  );
  await page.route("**/me/wallet/balances", (route) =>
    route.fulfill({ json: { wallets: [] } }),
  );
  await page.route("**/apps/review-queue", (route) =>
    route.fulfill({ status: 403, json: { error: "forbidden" } }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const cards = page.locator("[data-profile-collection] li .jpegpe-card");
  await expect(cards).toHaveCount(2);
  const ownBackgrounds = await cards.evaluateAll((nodes) =>
    nodes.map((node) =>
      getComputedStyle(node).getPropertyValue("--frog-card-bg").trim(),
    ),
  );
  expect(ownBackgrounds).toEqual([
    first.background_color,
    second.background_color,
  ]);
  const materials = () =>
    page
      .locator("[data-profile-collection] li .frog-card-plane")
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return { fill: style.backgroundImage, shadow: style.boxShadow };
        }),
      );
  const before = await materials();
  expect(before[0]).not.toEqual(before[1]);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty("--surface-raised", "#FF00FF");
    root.style.setProperty("--surface-base", "#00FF00");
    root.style.setProperty("--shadow-rgb", "255 0 255");
  });
  expect(await materials()).toEqual(before);
});
