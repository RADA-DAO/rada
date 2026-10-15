import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import pg from "pg";
import { t } from "../../../packages/i18n/src/index.ts";
import enLocale from "../../../packages/i18n/locales/en.json" with { type: "json" };
import ukLocale from "../../../packages/i18n/locales/uk.json" with { type: "json" };
function signed(age = 0) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id: 101 }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...data.entries()]
          .sort()
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}
async function host(page: Page, initData = "") {
  await page.addInitScript(
    ({ initData }) => {
      const listeners = new Map<string, () => void>();
      const webApp = {
        initData,
        viewportHeight: innerHeight,
        safeAreaInset: { top: 12, bottom: 20 },
        contentSafeAreaInset: { top: 8 },
        ready() {},
        expand() {},
        setHeaderColor() {},
        setBackgroundColor() {},
        onEvent(name: string, cb: () => void) {
          listeners.set(name, cb);
        },
        offEvent(name: string) {
          listeners.delete(name);
        },
        BackButton: {
          show() {},
          hide() {},
          onClick(cb: () => void) {
            listeners.set("back", cb);
          },
          offClick() {
            listeners.delete("back");
          },
        },
      };
      Object.assign(window, {
        Telegram: { WebApp: webApp },
        fixtureHost: {
          back: () => listeners.get("back")?.(),
          resize: (height: number) => {
            webApp.viewportHeight = height;
            listeners.get("viewportChanged")?.();
          },
        },
      });
    },
    { initData },
  );
}
test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("401 (Unauthorized)")
    )
      throw new Error(message.text());
  });
});
test("guest navigation, settings focus, locale and native Back", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("--app-safe-top", "20px");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByText("Guest profile", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { fixtureHost: { back(): void } }).fixtureHost.back(),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox").selectOption("uk");
  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  await page
    .getByRole("button", { name: t("uk", "common.close"), exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as { fixtureHost: { back(): void } }).fixtureHost.back(),
  );
  await expect(
    page.getByRole("heading", { name: t("uk", "shell.apps"), exact: true }),
  ).toBeVisible();
});
test("keyboard overlay and layout resize preserve field and dismiss without submit", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    const field = document.createElement("input");
    field.inputMode = "numeric";
    field.id = "fixture-field";
    dialog.append(field);
    document.body.append(dialog);
    dialog.showModal();
  });
  const field = page.locator("#fixture-field");
  await field.fill("123");
  await page.evaluate(() =>
    (
      window as unknown as { fixtureHost: { resize(height: number): void } }
    ).fixtureHost.resize(390),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-app-viewport-reduced",
    "true",
  );
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("123");
  await expect(
    page.getByRole("button", { name: "Hide keyboard", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Hide keyboard", exact: true })
    .click();
  await expect(field).not.toBeFocused();
  await page.setViewportSize({ width: 390, height: 440 });
  await page.evaluate(() =>
    (
      window as unknown as { fixtureHost: { resize(height: number): void } }
    ).fixtureHost.resize(440),
  );
  await field.focus();
  await field.press("Enter");
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue("123");
});
test("real API and PostgreSQL render only the own private profile", async ({
  page,
}) => {
  test.skip(
    !process.env.E2E_DATABASE_URL,
    "Requires isolated PostgreSQL integration environment",
  );
  await host(page, signed());
  await page.goto("/");
  const responsePromise = page.waitForResponse((r) => r.url().endsWith("/me"));
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const me = await response.json();
  expect(me.profile).toEqual({ visibility: "private", public: null });
  await expect(
    page.getByText("Private profile", { exact: true }),
  ).toBeVisible();
  const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const result = await db.query(
      "SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id = 101",
    );
    expect(result.rows[0].subject_id).toBe(me.subject_id);
  } finally {
    await db.end();
  }
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.content()).not.toContain("synthetic-fixture-bot-token");
});
test("profile projects each validated membership status and refreshes on click", async ({
  page,
}) => {
  await host(page, signed());
  let status: unknown = "member";
  let requests = 0;
  await page.route("**/me", (route) => {
    requests++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subject_id: "fixture-subject",
        profile: { visibility: "private", public: null },
        membership: { status },
      }),
    });
  });
  await page.goto("/");
  const profile = page.getByRole("button", { name: "Profile", exact: true });
  const projected = [
    ["member", enLocale.shell.membership.member],
    ["not_member", enLocale.shell.membership.not_member],
    ["unavailable", enLocale.shell.membership.unavailable],
  ] as const;
  for (const [value, label] of projected) {
    status = value;
    await profile.click();
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    if (value !== "unavailable")
      await expect(
        page.getByText(enLocale.shell.private, { exact: true }),
      ).toBeVisible();
    await page
      .getByRole("button", { name: enLocale.shell.apps, exact: true })
      .click();
  }
  expect(requests).toBe(3);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox").selectOption("uk");
  await page
    .getByRole("button", { name: t("uk", "common.close"), exact: true })
    .click();
  status = "member";
  await page
    .getByRole("button", { name: ukLocale.shell.profile, exact: true })
    .click();
  await expect(
    page.getByText(ukLocale.shell.membership.member, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: ukLocale.shell.apps, exact: true })
    .click();
  for (const malformed of ["unexpected", ["member"]]) {
    status = malformed;
    await page
      .getByRole("button", { name: ukLocale.shell.profile, exact: true })
      .click();
    await expect(
      page.getByText(ukLocale.shell.unavailable, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(enLocale.shell.membership.member, { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: ukLocale.shell.apps, exact: true })
      .click();
  }
});
test("expired authentication has a manual retry", async ({ page }) => {
  test.skip(
    !process.env.E2E_DATABASE_URL,
    "Requires isolated PostgreSQL integration environment",
  );
  await host(page, signed(90000));
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByText("Session expired", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("swipe and visible Back share the launcher destination", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const bounds = (await page.locator(".screen").boundingBox())!;
  await page.mouse.move(bounds.x + 24, 240);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.85, 245, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "Back to apps" }).click();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
});
test("unavailable response can recover with manual retry", async ({ page }) => {
  await host(page, signed());
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let interrupted = false;
    window.fetch = (input, init) => {
      if (!interrupted && String(input).endsWith("/me")) {
        interrupted = true;
        return Promise.reject(
          new TypeError("Synthetic connection interruption"),
        );
      }
      return originalFetch(input, init);
    };
  });
  let attempts = 0;
  await page.route("**/me", (route) => {
    attempts++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subject_id: "fixture-subject",
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByText("Profile unavailable", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Private profile", { exact: true }),
  ).toBeVisible();
});
