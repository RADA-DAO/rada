import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { release } from "./home-fixture.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";

type FixtureHost = { links: string[]; back(): void };
const text = (locale: Locale, key: string) => t(locale, key as MessageKey);
const active = (page: Page) =>
  page.locator(".rada-workspace-page:not([inert])");
const forbidden =
  /\/(?:apps\/(?:published|launcher|review-queue)|rankings|governance|holders)(?:\/|\?|$)/;

/** All API traffic stays in this page; even an accidental write cannot reach a service. */
async function fixture(page: Page, unavailable = false) {
  const calls: string[] = [];
  const frog = {
    frog_id: randomUUID(),
    username: `Surface_${randomUUID().replaceAll("-", "").slice(0, 10)}`,
    background_color: "#364C44",
    accent_color: "#C5E896",
  };
  const subject = randomUUID();
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "telegram.org") return route.fulfill({ body: "" });
    const path = url.pathname.replace(/^\/api(?=\/)/, "");
    if (!url.pathname.startsWith("/api/") && url.port !== "8000")
      return route.continue();
    calls.push(`${route.request().method()} ${path}`);
    if (route.request().method() !== "GET")
      return route.fulfill({
        status: 405,
        json: { error: "fixture_read_only" },
      });
    if (path === "/me")
      return route.fulfill({
        json: {
          subject_id: subject,
          profile: { visibility: "public", public: frog },
          membership: { status: "member" },
        },
      });
    if (path === "/me/frogs")
      return route.fulfill({
        json: { frogs: [{ ...frog, artwork_path: null }] },
      });
    if (path.startsWith("/me/wallet"))
      return route.fulfill({ json: { wallets: [] } });
    if (path === "/v1/splash/round")
      return route.fulfill({ json: { round: null } });
    if (path === "/v1/splash/bids/mine")
      return route.fulfill({ json: { bids: [] } });
    if (path === "/v1/splash/submissions/mine")
      return route.fulfill({ json: { submissions: [] } });
    if (path === "/v1/splash/claims/mine")
      return route.fulfill({ json: { claims: [] } });
    if (path === "/v1/treasury/overview")
      return route.fulfill({ json: { wallets: [] } });
    if (path === "/v1/treasury/transactions")
      return route.fulfill({
        json: { transactions: [], nextCursor: null },
      });
    if (path === "/apps/published" && !unavailable)
      return route.fulfill({
        json: {
          apps: [release("fixture.extra", "Forbidden extra app", "official")],
        },
      });
    if (path.includes("notifications"))
      return route.fulfill({ json: { preferences: [] } });
    return route.fulfill({
      status: 503,
      json: { error: "fixture_unavailable" },
    });
  });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const callbacks = new Map<string, () => void>();
    const links: string[] = [];
    // Runtime flags and URL parameters cannot widen the compiled release policy.
    for (const key of [
      "developer",
      "RADA_DEVELOPER_SURFACE",
      "rada.developer",
      "rada.surface",
    ])
      localStorage.setItem(key, "true");
    Object.assign(window, {
      fixtureHost: { links, back: () => callbacks.get("back")?.() },
      Telegram: {
        WebApp: {
          initData: "synthetic-product-surface",
          viewportHeight: innerHeight,
          isFullscreen: true,
          // Both insets use the same viewport origin and overlap.
          safeAreaInset: { top: 47, bottom: 34 },
          contentSafeAreaInset: { top: 46, bottom: 0 },
          ready() {},
          expand() {},
          setHeaderColor() {},
          setBackgroundColor() {},
          onEvent(name: string, cb: () => void) {
            callbacks.set(name, cb);
          },
          offEvent(name: string) {
            callbacks.delete(name);
          },
          openTelegramLink(url: string) {
            links.push(url);
          },
          BackButton: {
            show() {},
            hide() {},
            onClick(cb: () => void) {
              callbacks.set("back", cb);
            },
            offClick() {
              callbacks.delete("back");
            },
          },
        },
      },
    });
  });
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/?developer=true&RADA_DEVELOPER_SURFACE=true");
  return { calls, frog };
}

async function assertDesktop(page: Page, locale: Locale) {
  const navigation = page.getByRole("navigation", {
    name: text(locale, "shell.navigation"),
  });
  await expect(navigation.getByRole("button")).toHaveCount(3);
  await expect(
    navigation.getByRole("button", {
      name: text(locale, "shell.myProfile"),
      exact: true,
    }),
  ).toBeVisible();
  const leaderboard = navigation.getByRole("button", {
    name: new RegExp(text(locale, "shell.leaderboard")),
  });
  await expect(leaderboard).toBeDisabled();
  await expect(leaderboard).toContainText(text(locale, "shell.comingSoon"));
  const list = active(page).getByRole("list", {
    name: text(locale, "home.gridLabel"),
  });
  const names = [
    "splash.title",
    "treasury.title",
    "launcher.tasks",
    "launcher.cryptonos",
  ].map((key) => text(locale, key));
  await expect(list.getByRole("button")).toHaveCount(4);
  for (const name of names)
    await expect(list.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(
    page.locator(".rada-launcher-folder, .rada-launcher-editor"),
  ).toHaveCount(0);
  await expect(page.getByRole("searchbox")).toHaveCount(0);
  await expect(
    page.getByText("Forbidden extra app", { exact: true }),
  ).toHaveCount(0);
  for (const key of [
    "launcher.edit",
    "launcher.favourites",
    "review.title",
    "shell.appPermissions",
  ])
    await expect(
      page.getByRole("button", { name: text(locale, key), exact: true }),
    ).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => "RadaAppHost" in window))
    .toBe(false);
}

async function assertGeometry(page: Page) {
  const faults = await page.evaluate(() => {
    const errors: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth + 1)
      errors.push("horizontal overflow");
    for (const control of document.querySelectorAll<HTMLElement>(
      "button, select, input, [role=switch]",
    )) {
      if (control.closest("[inert], [hidden]")) continue;
      const box = control.getBoundingClientRect();
      if (
        !box.width ||
        !box.height ||
        getComputedStyle(control).visibility === "hidden"
      )
        continue;
      if (box.width < 43.5 || box.height < 43.5)
        errors.push(
          `${control.getAttribute("aria-label") ?? control.textContent}: ${String(box.width)}x${String(box.height)}`,
        );
    }
    const brand = document
      .querySelector(".rada-shell-header button")
      ?.getBoundingClientRect();
    if (!brand || brand.top < 47) errors.push("Telegram header safe area");
    const content =
      document.querySelector(
        ".rada-workspace-page:not([inert]) .rada-screen",
      ) ?? document.querySelector(".rada-workspace-page:not([inert]) > *");
    const contentTop = content?.getBoundingClientRect().top;
    if (
      contentTop === undefined ||
      contentTop < Math.max(87, brand?.bottom ?? 87)
    )
      errors.push("Telegram content clearance");
    return errors;
  });
  expect(faults).toEqual([]);
}

for (const unavailable of [false, true]) {
  test(`release surface ignores ${unavailable ? "unavailable" : "extra advertised"} apps and runtime flags`, async ({
    page,
  }) => {
    const { calls, frog } = await fixture(page, unavailable);
    await assertDesktop(page, "en");
    await assertGeometry(page);
    if (!unavailable)
      await page.screenshot({
        path: test.info().outputPath("product-desktop.png"),
        fullPage: true,
      });
    await page
      .getByRole("button", { name: text("en", "shell.myProfile"), exact: true })
      .click();
    await expect(active(page).locator(".rada-profile-banner")).toBeVisible();
    await expect(active(page).locator(".rada-profile-name")).toHaveText(
      frog.username.toUpperCase(),
    );
    await assertGeometry(page);
    if (!unavailable)
      await page.screenshot({
        path: test.info().outputPath("my-profile.png"),
        fullPage: true,
      });
    await page
      .getByRole("button", { name: text("en", "shell.settings"), exact: true })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await assertGeometry(page);
    await page
      .getByRole("combobox", { name: text("en", "shell.language") })
      .selectOption("uk");
    await expect(page.locator("html")).toHaveAttribute("lang", "uk");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: text("uk", "common.close"), exact: true })
      .click();
    await page
      .getByRole("button", { name: text("uk", "shell.action"), exact: true })
      .click();
    await assertDesktop(page, "uk");
    await page.reload();
    await assertDesktop(page, "en");
    expect(calls.filter((call) => forbidden.test(call))).toEqual([]);
    expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
  });
}

test("external products use canonical Telegram destinations without launching bots", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await assertDesktop(page, "en");
  for (const key of ["launcher.tasks", "launcher.cryptonos"])
    await active(page)
      .getByRole("button", { name: text("en", key), exact: true })
      .click();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixtureHost: FixtureHost }).fixtureHost.links,
    ),
  ).toEqual([
    "https://t.me/DAORADAbot?startapp=tasker",
    "https://t.me/CryptonosShop_bot?start=ref_7221274829",
  ]);
  await assertDesktop(page, "en");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(calls.filter((call) => forbidden.test(call))).toEqual([]);
});

test("native SPLASH and Treasury open with read-only fixtures and return through Back", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await assertDesktop(page, "en");
  await active(page)
    .getByRole("button", { name: text("en", "splash.title"), exact: true })
    .click();
  await expect(page.locator(".splash-screen")).toBeVisible();
  await expect(
    page.getByText(text("en", "splash.noRound"), { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".splash-inline-error")).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { fixtureHost: FixtureHost }).fixtureHost.back();
  });
  await assertDesktop(page, "en");
  await expect(page.locator(".splash-screen")).toHaveCount(0);

  await active(page)
    .getByRole("button", { name: text("en", "treasury.title"), exact: true })
    .click();
  await expect(page.locator(".rada-treasury-view")).toBeVisible();
  await expect(
    page.getByText(text("en", "treasury.unconfigured"), { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(text("en", "treasury.empty"), { exact: true }),
  ).toBeVisible();
  await page.goBack();
  await assertDesktop(page, "en");
  await expect(page.locator(".rada-treasury-view")).toHaveCount(0);

  for (const path of [
    "/v1/splash/round",
    "/v1/splash/bids/mine",
    "/v1/splash/submissions/mine",
    "/v1/splash/claims/mine",
    "/v1/treasury/overview",
    "/v1/treasury/transactions",
  ])
    expect(calls).toContain(`GET ${path}`);
  expect(calls.filter((call) => !call.startsWith("GET "))).toEqual([]);
  expect(calls.filter((call) => forbidden.test(call))).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { fixtureHost: FixtureHost }).fixtureHost.links,
    ),
  ).toEqual([]);
});

/** Chromium receives real touch events; WebKit uses its primary pointer. */
async function swipe(page: Page, right: boolean) {
  const box = await page
    .locator('.screen[data-workspace="true"]')
    .boundingBox();
  if (!box) throw new Error("Missing workspace gesture surface");
  const start = box.x + (right ? 24 : box.width - 24);
  const end = box.x + (right ? box.width - 24 : 24);
  const y = box.y + Math.min(200, box.height / 2);
  if (test.info().project.name.startsWith("chromium")) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: start, y }],
    });
    for (let i = 1; i <= 12; i++)
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start + ((end - start) * i) / 12, y: y + 3 }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
  } else {
    await page.mouse.move(start, y);
    await page.mouse.down();
    await page.mouse.move(end, y + 3, { steps: 12 });
    await page.mouse.up();
  }
  await expect(page.locator(".rada-workspace-track")).not.toHaveAttribute(
    "data-settling",
    "true",
  );
}

test("two active root pages clamp swipes and leaderboard stays disabled", async ({
  page,
}) => {
  const { calls } = await fixture(page);
  await assertDesktop(page, "en");
  await expect(page.locator(".rada-workspace-page")).toHaveCount(2);
  const leaderboard = page.getByRole("button", {
    name: new RegExp(text("en", "shell.leaderboard")),
  });
  await expect(leaderboard).toBeDisabled();
  await expect(leaderboard).toContainText(text("en", "shell.comingSoon"));
  await leaderboard.focus();
  await page.keyboard.press("Enter");
  await assertDesktop(page, "en");
  await swipe(page, false);
  await assertDesktop(page, "en");
  await swipe(page, true);
  await expect(active(page).locator(".rada-profile-banner")).toBeVisible();
  await swipe(page, true);
  await expect(active(page).locator(".rada-profile-banner")).toBeVisible();
  await swipe(page, false);
  await assertDesktop(page, "en");
  expect(calls.filter((call) => forbidden.test(call))).toEqual([]);
});
