import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { walletProof } from "../../api/src/fixtures/wallet-proof.ts";
import { t } from "../../../packages/i18n/src/index.ts";

function signed() {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 101 }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...data]
          .sort()
          .map(([k, v]) => `${k}=${v}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}

test("wallet balances display, unlink, TON Connect relink and restored session", async ({
  page,
  request,
}) => {
  const token = signed();
  const headers = { Authorization: `tma ${token}` };
  const api = "http://127.0.0.1:8000";
  const response = await request.post(`${api}/me/wallet/challenge`, {
    headers,
  });
  expect(response.status()).toBe(200);
  const { payload } = (await response.json()) as { payload: string };
  const proof = walletProof(payload);
  const linked = await request.post(`${api}/me/wallet/link`, {
    headers,
    data: proof,
  });
  expect(linked.status()).toBe(200);
  const body = (await linked.json()) as { wallet: { address: string } };
  const shortAddress = `${body.wallet.address.slice(0, 4)}…${body.wallet.address.slice(-4)}`;
  try {
    let nextProof = proof;
    await page.route("**/me/wallet/challenge", async (route) => {
      const response = await route.fetch();
      const challenge = (await response.json()) as { payload: string };
      nextProof = walletProof(challenge.payload);
      await route.fulfill({ response });
    });
    await page.route("**/__fixture/ton-connect-proof", (route) =>
      route.fulfill({ json: nextProof }),
    );
    await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
      route.fulfill({ body: "" }),
    );
    // Only read projections are mocked in the browser; proof/link/revoke hit the real API.
    await page.route("**/me/wallet/balances", (route) =>
      route.fulfill({
        json: {
          wallets: [
            {
              address: body.wallet.address,
              balances: {
                gram: {
                  raw: "900719925474099312345",
                  decimals: 9,
                  formatted: "900719925474.099312345",
                },
                jpegpe: {
                  raw: "12345678901234567890",
                  decimals: 9,
                  formatted: "12345678901.23456789",
                },
                balancesUpdatedAt: new Date().toISOString(),
              },
            },
          ],
        },
      }),
    );
    await page.addInitScript((token) => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText(value: string) {
            sessionStorage.setItem("fixture-copied-address", value);
            return Promise.resolve();
          },
        },
        configurable: true,
      });
      Object.assign(window, {
        Telegram: {
          WebApp: {
            initData: token,
            ready() {},
            expand() {},
            onEvent() {},
            offEvent() {},
            BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
          },
        },
      });
    }, token);
    await page.goto("/");
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByText(shortAddress, { exact: true })).toBeVisible();
    await expect(
      page.getByText("TON: 900,719,925,474.10 · JPEGPE: 12,345,678,901.23", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy full address" }).click();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("fixture-copied-address"),
      ),
    ).toBe(body.wallet.address);
    await page
      .getByRole("button", { name: "Remove wallet link", exact: true })
      .click();
    await expect(page.getByText(shortAddress, { exact: true })).toHaveCount(0);
    const own = await request.get(`${api}/me/wallet`, { headers });
    expect(await own.json()).toEqual({ wallets: [] });
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByText(shortAddress, { exact: true })).toBeVisible();
    await request.post(`${api}/me/wallet/revoke`, {
      headers,
      data: { address: proof.address },
    });
    await page.reload();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByText("No wallet linked yet.")).toBeVisible();
    await page.getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByText(shortAddress, { exact: true })).toBeVisible();
    expect(
      await page.evaluate(() =>
        Number(localStorage.getItem("fixture-ton-disconnects")),
      ),
    ).toBeGreaterThanOrEqual(1);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("combobox", { name: "Language" }).selectOption("uk");
    await page.getByRole("button", { name: t("uk", "common.close") }).click();
    await expect(
      page.getByText(
        `${t("uk", "wallet.ton")}: ${new Intl.NumberFormat("uk").format(900719925474n)},10 · ${t("uk", "wallet.jpegpe")}: ${new Intl.NumberFormat("uk").format(12345678901n)},23`,
        { exact: true },
      ),
    ).toBeVisible();
  } finally {
    await request.post(`${api}/me/wallet/revoke`, {
      headers,
      data: { address: proof.address },
    });
  }
});
