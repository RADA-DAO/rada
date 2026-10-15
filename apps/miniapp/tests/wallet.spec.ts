import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { walletProof } from "../../api/src/fixtures/wallet-proof.ts";

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

test("verified wallet appears in profile with exact balances and can be revoked", async ({
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
  try {
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
    await page.addInitScript(
      (token) =>
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
        }),
      token,
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(
      page.getByText(body.wallet.address, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "TON: 900719925474.099312345 · JPEGPE: 12345678901.23456789",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Remove wallet link", exact: true })
      .click();
    await expect(
      page.getByText(body.wallet.address, { exact: true }),
    ).toHaveCount(0);
    const own = await request.get(`${api}/me/wallet`, { headers });
    expect(await own.json()).toEqual({ wallets: [] });
  } finally {
    await request.post(`${api}/me/wallet/revoke`, {
      headers,
      data: { address: proof.address },
    });
  }
});
