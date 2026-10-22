import { test, expect } from "@playwright/test";
import {
  installHomeFixtures,
  launch,
  pressBack,
  published,
  release,
} from "./home-fixture.ts";

installHomeFixtures();

test("system folders show catalog categories, preserve workspace chrome and restore focus", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({
      json: {
        apps: [
          ...published,
          release("fixture.notes", "Notes fixture", "community"),
        ],
      },
    }),
  );
  await launch(page);
  await expect(
    page.getByRole("button", { name: "Game fixture", exact: true }),
  ).toBeVisible();
  const folder = page.locator(".rada-launcher-folder");
  for (const [name, contents] of [
    ["RADA", ["DAO", "Treasury", "Holders", "Governance fixture"]],
    ["Games", ["SPLASH", "Game fixture"]],
    ["Apps", ["Notes fixture", "CryptoNos"]],
    ["Favourites", []],
  ] as const) {
    const opener = page
      .locator("[data-folder]")
      .getByText(name, { exact: true });
    await opener.click();
    await expect(
      folder.getByRole("heading", { name, exact: true }),
    ).toBeFocused();
    await expect(page.locator(".rada-os-wordmark")).toBeVisible();
    await expect(
      page.locator(".rada-page-dots [aria-current='page']"),
    ).toHaveAccessibleName("Apps");
    await expect(folder.getByRole("listitem")).toHaveCount(contents.length);
    for (const app of contents)
      await expect(
        folder.getByRole("button", { name: app, exact: true }),
      ).toBeVisible();
    if (!contents.length)
      await expect(folder).toContainText("No matching apps");
    await folder
      .getByRole("button", { name: "← Desktop", exact: true })
      .click();
    await expect(opener.locator("..")).toBeFocused();
  }

  const games = page.getByRole("button", { name: "Games", exact: true });
  await games.click();
  await page
    .locator(".rada-page-dots")
    .getByRole("button", { name: "Apps", exact: true })
    .click();
  await expect(folder).toHaveCount(0);
  await expect(games).toBeFocused();
  for (const close of [
    () => pressBack(page),
    () => page.goBack(),
    () => page.keyboard.press("Escape"),
  ]) {
    await games.click();
    await expect(folder).toBeVisible();
    await close();
    await expect(folder).toHaveCount(0);
    await expect(games).toBeFocused();
  }
  await games.click();
  const title = await folder.getByRole("heading").boundingBox();
  const bounds = await page.locator(".screen").boundingBox();
  if (!title || !bounds) throw new Error("Folder bounds unavailable");
  const y = title.y + title.height / 2;
  await page.mouse.move(bounds.x + 12, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.85, y + 4, { steps: 12 });
  await page.mouse.up();
  await expect(folder).toHaveCount(0);
  await expect(games).toBeFocused();

  await games.click();
  await folder.getByRole("button", { name: "SPLASH", exact: true }).click();
  await expect(folder).toHaveCount(0);
  await pressBack(page);
  await expect(
    page.getByRole("button", { name: "Games", exact: true }),
  ).toBeVisible();
});

test("favourites project the saved viewer layout", async ({ page }) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await page.route("**/apps/launcher/layout", (route) =>
    route.fulfill({
      json: {
        version: 1,
        layout: {
          order: [],
          pinned: [],
          folders: [],
          favourites: ["builtin:splash", "fixture.game", "unavailable.app"],
        },
      },
    }),
  );
  await launch(page);
  await expect(
    page.getByRole("button", { name: "Game fixture", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  const folder = page.locator(".rada-launcher-folder");
  await expect(folder.getByRole("listitem")).toHaveCount(2);
  await expect(
    folder.getByRole("button", { name: "SPLASH", exact: true }),
  ).toBeVisible();
  await expect(
    folder.getByRole("button", { name: "Game fixture", exact: true }),
  ).toBeVisible();
});
