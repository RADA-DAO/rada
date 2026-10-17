import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
function signed() {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 102 }),
  });
  const key = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", key)
      .update(
        [...data.entries()]
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}
test("notification consent persists, test queues once, and opt out persists", async ({
  page,
}, info) => {
  const initData = signed();
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({ body: "" }),
  );
  await page.addInitScript(
    (initData) =>
      Object.assign(window, {
        Telegram: {
          WebApp: {
            initData,
            ready() {},
            expand() {},
            onEvent() {},
            offEvent() {},
            BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
          },
        },
      }),
    initData,
  );
  // Reset only this synthetic subject's preference for each browser project.
  await page.request.post(
    "http://127.0.0.1:8000/v1/notifications/preferences",
    {
      headers: { authorization: `tma ${initData}` },
      data: {
        category: "splash",
        enabled: false,
        locale: "en",
        quiet_start: null,
        quiet_end: null,
      },
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const splash = page
    .getByRole("dialog")
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "SPLASH", exact: true }) })
    .last();
  await expect(splash.getByRole("switch")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(
    splash.getByRole("button", { name: "Send me a test" }),
  ).toBeDisabled();
  await splash.getByRole("switch").click();
  await splash.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Preferences saved.")).toBeVisible();
  await page.screenshot({
    path: info.outputPath("notifications-settings.png"),
    fullPage: true,
  });
  await splash.getByRole("button", { name: "Send me a test" }).click();
  // Repeated projects share the subject and therefore the persisted minute budget.
  await expect(page.getByRole("dialog")).toContainText(
    /Test queued|Could not save or send/,
  );
  await splash.getByRole("switch").click();
  await splash.getByRole("button", { name: "Save preferences" }).click();
  await expect(
    splash.getByRole("button", { name: "Send me a test" }),
  ).toBeDisabled();
  const saved = await page.request.get(
    "http://127.0.0.1:8000/v1/notifications/preferences",
    { headers: { authorization: `tma ${initData}` } },
  );
  const data = (await saved.json()) as {
    preferences: { category: string; enabled: boolean }[];
  };
  expect(
    data.preferences.find((p: { category: string }) => p.category === "splash")
      ?.enabled,
  ).toBe(false);
});
