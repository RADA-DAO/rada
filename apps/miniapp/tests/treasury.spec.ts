import {
  t,
  displayAmount,
  type Locale,
} from "../../../packages/i18n/src/index.ts";
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
async function launch(page: Page, locale: Locale = "en") {
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
  if (locale !== "en") {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Language", { exact: true }).selectOption(locale);
    await page
      .getByRole("button", { name: t(locale, "common.close"), exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: t(locale, "treasury.title"), exact: true })
    .click();
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
  await expect(
    page.getByRole("region", { name: "All assets", exact: true }),
  ).toContainText("1.23456789 TON");
  await expect(
    page.getByRole("heading", { name: "Where assets are", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "History", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Multisig", exact: true }).click();
  await expect(page.getByText("PublicFrog")).toBeVisible();
  await expect(page.getByText("History may be incomplete")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  expect(queries.some((q) => q.includes("before=2"))).toBe(true);
  await expect(page.locator(".rada-treasury-day")).toHaveCount(1);
  await expect(page.locator(".rada-treasury-movement")).toHaveCount(2);
  await page.getByText("Filters", { exact: true }).click();
  await page.getByRole("button", { name: "Outgoing", exact: true }).click();
  await expect
    .poll(() => queries.some((q) => q.includes("direction=out")))
    .toBe(true);
  await expect(page.getByText("Anonymous", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Anonymous", { exact: true })).toBeVisible();
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

test("treasury totals exact token balances and identifies partial coverage without USD placeholders", async ({
  page,
}) => {
  const base = {
    asOf: "2026-10-01T00:00:00Z",
    stale: false,
    historyStale: false,
    indexedThrough: "2026-10-01T00:00:00Z",
    signers: [],
    signersAsOf: "2026-10-01T00:00:00Z",
    signersStale: false,
  };
  await page.route("**/v1/treasury/overview", (r) =>
    r.fulfill({
      json: {
        wallets: [
          {
            ...base,
            address: `0:${"1".repeat(64)}`,
            balances: { TON: "1000000001", JPEGPE: "2000000000" },
          },
          {
            ...base,
            address: `0:${"2".repeat(64)}`,
            balances: { TON: "2000000002", JPEGPE: "3000000000" },
          },
          { ...base, address: `0:${"3".repeat(64)}`, balances: null },
        ],
      },
    }),
  );
  await page.route("**/v1/treasury/transactions*", (r) =>
    r.fulfill({ json: { transactions: [], nextCursor: null } }),
  );
  await launch(page);
  const summary = page.getByRole("region", { name: "All assets", exact: true });
  await expect(summary).toContainText("3.000000003 TON");
  await expect(summary).toContainText("5 JPEGPE");
  await expect(summary).toContainText("Partial balances");
  await expect(page.locator(".rada-treasury-values").last()).toHaveText(
    "Unavailable",
  );
  await expect(page.locator(".rada-treasury-view")).not.toContainText("$");
  const wallet = page
    .getByRole("button", { name: "Multisig", exact: true })
    .last();
  await wallet.click();
  await expect(wallet).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText(`0:${"3".repeat(64)}`, { exact: true }),
  ).toBeVisible();
  await wallet.click();
  await expect(wallet).toHaveAttribute("aria-expanded", "false");
});

for (const locale of ["en", "uk"] as const) {
  test(`treasury compacts million-scale row amounts with exact labels (${locale})`, async ({
    page,
  }) => {
    const amounts = [
      "999999123456789",
      "1000000000000000",
      "1300000123456789",
      "1000000000000000000",
    ] as const;
    const exact = (raw: string) =>
      `${displayAmount({ raw, decimals: 9 }, locale, 0, 9) ?? ""} JPEGPE`;
    await page.route("**/v1/treasury/overview", (r) =>
      r.fulfill({
        json: {
          wallets: [
            {
              address: `0:${"1".repeat(64)}`,
              balances: { TON: "1000000000", JPEGPE: amounts[2] },
              asOf: "2026-10-01T00:00:00Z",
              stale: false,
              historyStale: false,
              indexedThrough: "2026-10-01T00:00:00Z",
              signers: [],
              signersAsOf: "2026-10-01T00:00:00Z",
              signersStale: false,
            },
          ],
        },
      }),
    );
    await page.route("**/v1/treasury/transactions*", (r) =>
      r.fulfill({
        json: {
          transactions: amounts.map((amount, index) => ({
            id: String(index),
            at: "2026-10-01T00:00:00Z",
            direction: index % 2 ? "in" : "out",
            token: "JPEGPE",
            amount,
            person: null,
            decisions: [],
          })),
          nextCursor: null,
        },
      }),
    );
    await launch(page, locale);
    const formatter = new Intl.NumberFormat(locale, {
      notation: "compact",
      maximumFractionDigits: 1,
    });
    const wallet = page.locator(".rada-treasury-wallet");
    const balance = wallet.locator(".rada-treasury-values .rada-text").last();
    await expect(balance).toHaveText(
      `${formatter.format(1300000.123456789)} JPEGPE`,
    );
    await expect(balance).toHaveAttribute("title", exact(amounts[2]));
    await expect(wallet).toHaveAttribute(
      "title",
      new RegExp(exact(amounts[2]).replaceAll(".", "\\.")),
    );
    await expect(balance).toHaveCSS("white-space", "nowrap");
    await expect(page.locator(".rada-treasury-total")).toContainText(
      exact(amounts[2]),
    );
    for (const [index, raw] of amounts.entries()) {
      const row = page.locator(".rada-treasury-movement").nth(index);
      const quantity = row.locator(".rada-treasury-quantity");
      const visible =
        index === 0
          ? exact(raw)
          : `${formatter.format(Number(raw) / 1e9)} JPEGPE`;
      await expect(quantity).toHaveText(`${index % 2 ? "+" : "−"}${visible}`);
      await expect(quantity).toHaveCSS("white-space", "nowrap");
      await expect(row).toHaveAttribute(
        "aria-label",
        new RegExp(exact(raw).replaceAll(".", "\\.")),
      );
      await expect(row).toHaveAttribute(
        "title",
        (await row.getAttribute("aria-label")) ?? "",
      );
    }
  });
}

for (const history of ["pending", "failed"] as const) {
  test(`empty treasury renders while history is ${history}`, async ({
    page,
  }) => {
    await page.route("**/v1/treasury/overview", (r) =>
      r.fulfill({ json: { wallets: [] } }),
    );
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/v1/treasury/transactions*", async (r) => {
      if (history === "pending") await pending;
      await r.fulfill({ status: 503, json: { error: "unavailable" } });
    });
    await page.addInitScript(() => {
      const NumberFormat = Intl.NumberFormat;
      Intl.NumberFormat = new Proxy(NumberFormat, {
        construct(
          target,
          args: ConstructorParameters<typeof Intl.NumberFormat>,
        ) {
          if (args[1]?.notation === "compact")
            throw new RangeError("unsupported");
          return new target(...args);
        },
      });
    });
    try {
      await launch(page);
      await expect(
        page.getByText("No treasury wallets configured yet."),
      ).toBeVisible();
      if (history === "failed")
        await expect(page.getByText("Treasury is unavailable.")).toBeVisible();
    } finally {
      release();
    }
  });
}
