import { test, expect } from "@playwright/test";
import { launch } from "./home-fixture.ts";
import { signedLaunch } from "./telegram-fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
});

test("shared spacing tokens update the screen, header and navigation", async ({
  page,
}) => {
  await launch(page, signedLaunch());
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.focus();
  await expect(settings).toHaveCSS("outline-style", "solid");
  await expect(settings).toHaveCSS("outline-width", "2px");
  await expect(settings).toHaveCSS("outline-color", "rgb(0, 0, 0)");
  await expect(settings).toHaveCSS(
    "box-shadow",
    "rgb(255, 255, 255) 0px 0px 0px 2px",
  );
  const screen = page.locator('.rada-workspace-page[data-home="true"]');
  const header = screen.locator(".rada-screen-header");
  const navigation = page.getByRole("navigation");
  await expect(screen).toHaveCSS("padding-top", "12px");
  await expect(screen).toHaveCSS("padding-left", "18px");
  await expect(header).toHaveCSS("gap", "16px");
  await expect(navigation.getByRole("button").first()).toHaveCSS(
    "width",
    "44px",
  );
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--rada-space-4", "24px");
    document.documentElement.style.setProperty("--rada-space-3", "20px");
    document.documentElement.style.setProperty("--rada-page-gutter", "22px");
    document.documentElement.style.setProperty("--rada-os-dot-target", "48px");
  });
  await expect(screen).toHaveCSS("padding-top", "20px");
  await expect(screen).toHaveCSS("padding-left", "22px");
  await expect(header).toHaveCSS("gap", "24px");
  await expect(navigation.getByRole("button").first()).toHaveCSS(
    "width",
    "48px",
  );
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
  await page
    .getByRole("button", { name: "Open collection", exact: true })
    .click();
  const cards = page.locator(".rada-frog-gallery li .jpegpe-card");
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
      .locator(".rada-frog-gallery li .frog-card-plane")
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

test("screen changes focus headings and long screens keep navigation in view", async ({
  page,
}) => {
  await launch(page, signedLaunch());
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeFocused();
  for (const name of ["Profile", "Apps"]) {
    await page
      .getByRole("navigation", { name: "Navigation", exact: true })
      .getByRole("button", { name, exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name, exact: true }),
    ).toBeFocused();
    await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>(
        ".rada-workspace-page:not([inert]) .rada-screen-body",
      );
      if (!body) throw new Error("Missing body");
      body.style.minHeight = "3000px";
    });
    const navigation = page.getByRole("navigation");
    for (const scroll of [0, 1500, 5000]) {
      await page
        .locator(".rada-workspace-page:not([inert])")
        .evaluate((screen, y) => {
          screen.scrollTo(0, y);
        }, scroll);
      await expect(navigation).toBeInViewport({ ratio: 1 });
      await expect(
        navigation.getByRole("button", { name: "Profile", exact: true }),
      ).toBeVisible();
    }
  }
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeFocused();
});
