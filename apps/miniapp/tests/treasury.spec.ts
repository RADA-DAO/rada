import { proposal } from "./governance-fixture.ts";
import { test, expect, type Page } from "@playwright/test";
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
async function launch(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (r) =>
    r.fulfill({ body: "" }),
  );
  await page.addInitScript((initData) => {
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
    });
  }, signed());
  await page.goto("/");
  await page.getByRole("button", { name: "Treasury", exact: true }).click();
}
test("real treasury read endpoint is empty and nonsteward configuration is denied", async ({
  page,
}) => {
  await launch(page);
  await expect(
    page.getByText("No treasury wallets configured yet."),
  ).toBeVisible();
  const response = await page.request.post(
    "http://127.0.0.1:8000/v1/treasury/config",
    {
      headers: { authorization: `tma ${signed()}` },
      data: {
        address: `0:${"1".repeat(64)}`,
        enabled: true,
        reason: "Fixture",
      },
    },
  );
  expect(response.status()).toBe(403);
  await expect(
    page.getByRole("button", { name: /sign|pay|send/i }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Treasury", exact: true }),
  ).toBeVisible();
});
test("treasury renders privacy-safe stale samples, filters, pagination and retry", async ({
  page,
}) => {
  let failed = true;
  const queries: string[] = [];
  await page.route("**/v1/treasury/overview", (r) =>
    r.fulfill({
      json: {
        wallets: [
          {
            address: `0:${"1".repeat(64)}`,
            balances: { TON: "1234567890", JPEGPE: "0" },
            asOf: "2026-10-01T00:00:00Z",
            stale: true,
            historyStale: true,
            indexedThrough: null,
            signers: [{ name: "PublicFrog", frogId: "fixture" }, null],
            signersAsOf: null,
            signersStale: true,
          },
        ],
      },
    }),
  );
  await page.route("**/v1/treasury/transactions*", (r) => {
    queries.push(r.request().url());
    if (failed) {
      failed = false;
      return r.fulfill({ status: 503, json: { error: "unavailable" } });
    }
    const more = new URL(r.request().url()).searchParams.has("before");
    return r.fulfill({
      json: {
        transactions: [
          {
            id: more ? "1" : "2",
            at: "2026-10-01T00:00:00Z",
            direction: "in",
            token: "TON",
            amount: "1000000000",
            person: null,
            decisions: [
              {
                proposalId: proposal().proposal_id,
                evidenceId: "fixture",
                title: "Community workshop",
              },
            ],
          },
        ],
        nextCursor: more ? null : "2",
      },
    });
  });
  await page.route("**/v1/governance/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    return r.fulfill({
      json: path.endsWith("/viewer")
        ? { viewer: { steward: false } }
        : path.endsWith("/votes") || path.endsWith("/mine")
          ? { votes: [] }
          : { proposal: proposal() },
    });
  });
  await launch(page);
  await expect(page.getByText("Treasury is unavailable.")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByText("PublicFrog")).toBeVisible();
  await expect(page.getByText("History may be incomplete")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(queries.some((q) => q.includes("before=2"))).toBe(true);
  await page.getByRole("button", { name: "Outgoing", exact: true }).click();
  await expect
    .poll(() => queries.some((q) => q.includes("direction=out")))
    .toBe(true);
  await expect(
    page.getByText("Anonymous", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Decision: Community workshop" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Community workshop", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("heading", { name: "Treasury", exact: true }),
  ).toBeVisible();
});
