import { expect, type Page } from "@playwright/test";
import { crc32, deflateSync } from "node:zlib";
import { t } from "../../../packages/i18n/src/index.ts";

export const FROG = "11111111-1111-4111-8111-111111111111";
export const WON = "22222222-2222-4222-8222-222222222222";
export const INTENT = "00000000-0000-4000-8000-000000000301";
export const sender = `0:${"2".repeat(64)}`;
export const recipient = `0:${"1".repeat(64)}`;
export const en = (
  key: Parameters<typeof t>[1],
  values?: Record<string, string>,
) => t("en", key, values);
export const image = (id: string) => `/v1/splash/submissions/${id}/image`;

/** A plain 96x96 RGB PNG, built here so no file or network is needed. */
export function png(size = 96): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((size * 3 + 1) * size, 200);
  for (let y = 0; y < size; y++) rows[y * (size * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function launch(page: Page, wallet = false) {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.addInitScript(
    ({ wallet, sender }) => {
      if (wallet) {
        localStorage.setItem("fixture-ton-session", "restored");
        localStorage.setItem("fixture-ton-payment", "enabled");
        localStorage.setItem("fixture-ton-account", sender);
      }
      Object.assign(window, {
        Telegram: {
          WebApp: {
            initData: "synthetic-splash-fixture",
            ready() {},
            expand() {},
            onEvent() {},
            offEvent() {},
            BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
          },
        },
      });
    },
    { wallet, sender },
  );
  await page.route("**/me", (route) =>
    route.fulfill({
      json: {
        subject_id: "00000000-0000-4000-8000-000000000101",
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      },
    }),
  );
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: [] } }),
  );
  await page.route("**/v1/splash/submissions/*/image", (route) =>
    route.fulfill({ body: png(), contentType: "image/png" }),
  );
  await page.goto("/");
}
export const openSplash = async (page: Page) => {
  await page
    .getByRole("button", { name: en("splash.title"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: en("splash.title"), exact: true }),
  ).toBeVisible();
};
export const round = (topAmount: string | null, bidders: number) => ({
  round: {
    round_id: 7,
    starts_at: "2026-10-16T00:00:00.000Z",
    ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    accepting_bids: true,
    frogs: [
      {
        submission_id: FROG,
        submitted_at: "2026-10-15T10:00:00.000Z",
        width: 96,
        height: 96,
        background_removed: true,
        image_path: image(FROG),
        author: { username: "Painter" },
        top_amount: topAmount,
        bidder_count: bidders,
        leader: null,
      },
    ],
  },
});
