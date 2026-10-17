import { test, expect } from "@playwright/test";
import { createHmac, randomUUID, createHash } from "node:crypto";
import pg from "pg";
function signed(id: number, age = 0) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id }),
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
test("own frog selection, private clearing, transfer and app consent revocation", async ({
  page,
  request,
}) => {
  const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  const ownId = randomUUID();
  const foreignId = randomUUID();
  const name = `Fixture_${ownId.replaceAll("-", "").slice(0, 12)}`;
  const foreignName = `Foreign_${foreignId.replaceAll("-", "").slice(0, 12)}`;
  const appId = `fixture.profile.${randomUUID()}`;
  const token = signed(101);
  const headers = { Authorization: `tma ${token}` };
  const api = "http://127.0.0.1:8000";
  // A tiny synthetic raster exercises asset delivery without importing collectible art.
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=",
    "base64",
  );
  const path = `/media/jpegpe/${createHash("sha256").update(pixel).digest("hex")}.png`;
  try {
    const first = (
      await db.query<{ id: string }>(
        "SELECT identity.resolve_telegram(101) AS id",
      )
    ).rows[0]?.id;
    const second = (
      await db.query<{ id: string }>(
        "SELECT identity.resolve_telegram(102) AS id",
      )
    ).rows[0]?.id;
    if (!first || !second) throw new Error("Fixture identities missing");
    const readMe = async () =>
      (await (await request.get(`${api}/me`, { headers })).json()) as {
        profile: { visibility: string; public: { frog_id: string } | null };
      };
    await db.query(
      "INSERT INTO jpegpe.frogs(frog_id, username, creator_subject_id, current_owner_subject_id, background_color, accent_color, artwork_path) VALUES ($1,$2,$3,$3,'#123456','#ABCDEF',$4)",
      [ownId, name, first, path],
    );
    await db.query("SELECT jpegpe.import_artwork($1, 'image/png', false, $2)", [
      ownId,
      pixel,
    ]);
    await db.query(
      "UPDATE jpegpe.frogs SET colour_source = 'legacy_unverified' WHERE frog_id = $1",
      [ownId],
    );
    await db.query("SELECT jpegpe.create_frog($1,$2,$3)", [
      foreignId,
      foreignName,
      second,
    ]);
    expect(
      (
        await request.put(`${api}/me/profile-frog`, {
          headers,
          data: { frogId: null },
        })
      ).ok(),
    ).toBeTruthy();
    await request.put(`${api}/me/consents`, {
      headers,
      data: { appId, capability: "wallet.address.read", granted: true },
    });
    const detailResponse = await request.get(`${api}/me/frogs/${ownId}`, {
      headers,
    });
    expect(await detailResponse.json()).toEqual({
      creator: null,
      owner: null,
      colour_source: "legacy_unverified",
      history: [],
    });
    expect(
      (await request.get(`${api}/me/frogs/${foreignId}`, { headers })).status(),
    ).toBe(404);
    const collection = await request.get(
      `${api}/me/frogs?subject_id=${second}`,
      { headers },
    );
    const { frogs } = (await collection.json()) as {
      frogs: { frog_id: string }[];
    };
    expect(
      frogs.some((frog: { frog_id: string }) => frog.frog_id === foreignId),
    ).toBe(false);
    expect(
      Object.keys(
        frogs.find((frog: { frog_id: string }) => frog.frog_id === ownId) ?? {},
      ).sort(),
    ).toEqual([
      "accent_color",
      "artwork_path",
      "artwork_url",
      "background_color",
      "frog_id",
      "username",
    ]);
    expect(
      (
        await request.put(`${api}/me/profile-frog`, {
          headers,
          data: { frogId: foreignId },
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.put(`${api}/me/profile-frog`, {
          headers: { Authorization: `tma ${signed(101, 3700)}` },
          data: { frogId: ownId },
        })
      ).status(),
    ).toBe(401);
    await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
      route.fulfill({ body: "" }),
    );
    await page.route(`**${path}`, (route) =>
      route.fulfill({ contentType: "image/png", body: pixel }),
    );
    await page.addInitScript((token) => {
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
    const chunks: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/assets/")) chunks.push(request.url());
    });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Profile", exact: true }),
    ).toBeVisible();
    expect(chunks.some((url) => /profile-panel|collection-/.test(url))).toBe(
      false,
    );
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page
      .getByRole("button", { name: "Open collection", exact: true })
      .click();
    await expect(page.getByRole("list", { name: "Your frogs" })).toBeVisible();
    await page
      .getByRole("button", { name: `Open ${name.toUpperCase()}`, exact: true })
      .click();
    await expect(
      page.getByText("Legacy colours — unverified", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Use ${name.toUpperCase()}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(foreignName.toUpperCase(), { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: `Use ${name.toUpperCase()}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Make profile private", exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator("[data-selected-frog]")
        .getByRole("img", { name: name.toUpperCase() }),
    ).toBeVisible();
    await expect
      .poll(async () => (await readMe()).profile.public?.frog_id)
      .toBe(ownId);
    await page.route("**/v1/frogs/*/artwork/*", (route) =>
      route.fulfill({ status: 404 }),
    );
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Profile", exact: true })
      .click();
    await expect(
      page
        .locator("[data-selected-frog]")
        .getByText("Artwork unavailable", { exact: true }),
    ).toBeVisible();
    await page.unroute("**/v1/frogs/*/artwork/*");
    await page
      .getByRole("button", { name: "Make profile private", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open collection", exact: true })
      .click();
    await expect(page.getByRole("list", { name: "Your frogs" })).toBeVisible();
    await page
      .getByRole("button", { name: `Open ${name.toUpperCase()}`, exact: true })
      .click();
    await expect(
      page.getByText("Legacy colours — unverified", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: `Use ${name.toUpperCase()}`,
        exact: true,
      }),
    ).toBeVisible();
    expect((await readMe()).profile.visibility).toBe("private");
    await page
      .getByRole("button", { name: `Use ${name.toUpperCase()}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Make profile private", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "App permissions", exact: true })
      .click();
    const row = page
      .getByRole("dialog")
      .getByRole("listitem")
      .filter({ hasText: appId });
    await expect(row.getByRole("button")).toHaveAccessibleName(
      `Revoke permission ${appId} — your wallet address`,
    );
    await row.getByRole("button").click();
    await expect(row).toHaveCount(0);
    expect(
      (
        (await (
          await request.get(`${api}/me/consents`, { headers })
        ).json()) as { consents: { app_id: string }[] }
      ).consents.some((item: { app_id: string }) => item.app_id === appId),
    ).toBe(false);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await db.query("SELECT jpegpe.transfer_frog($1,$2,$3)", [
      ownId,
      first,
      second,
    ]);
    expect((await readMe()).profile.visibility).toBe("private");
    expect(
      (
        await request.put(`${api}/me/profile-frog`, {
          headers,
          data: { frogId: ownId },
        })
      ).status(),
    ).toBe(409);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Profile", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Make profile private", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: `Use ${name.toUpperCase()}`,
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await request.put(`${api}/me/profile-frog`, {
      headers,
      data: { frogId: null },
    });
    await db.end();
  }
});
