import { test, expect } from "@playwright/test";
import { emptyLayout } from "../../../packages/platform-sdk/src/launcher-layout.ts";
test("launcher search, groups, keyboard order, folders, CAS and external shortcut", async ({
  page,
}, info) => {
  let snapshot = { version: 0, layout: emptyLayout() };
  let conflict = false;
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.addInitScript(() => {
    Object.assign(window, {
      externalLinks: [],
      Telegram: {
        WebApp: {
          initData: "fixture",
          ready() {},
          expand() {},
          onEvent() {},
          offEvent() {},
          openTelegramLink(url: string) {
            (
              window as unknown as { externalLinks: string[] }
            ).externalLinks.push(url);
          },
          BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
        },
      },
    });
  });
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
  await page.route("**/apps/launcher/activity", (route) =>
    route.fulfill({ json: { recent: [], popular: [] } }),
  );
  await page.route("**/apps/launcher/layout", (route) => {
    if (route.request().method() === "POST") {
      if (conflict)
        return route.fulfill({
          status: 409,
          json: { error: "layout_conflict" },
        });
      const body = route.request().postDataJSON() as typeof snapshot;
      snapshot = { version: snapshot.version + 1, layout: body.layout };
    }
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  const search = page.getByRole("searchbox", { name: "Search apps" });
  await search.fill("trea");
  await expect(
    page.getByRole("list", { name: "Apps" }).getByRole("button"),
  ).toHaveCount(1);
  await expect(search).toBeFocused();
  await search.fill("");
  await page.getByRole("button", { name: "Games", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("No matching apps", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const external = page.getByRole("button", { name: "CryptoNos", exact: true });
  await expect(external).toHaveAccessibleDescription("Separate product");
  await external.click();
  expect(
    await page.evaluate(
      () => (window as unknown as { externalLinks: string[] }).externalLinks,
    ),
  ).toEqual(["https://t.me/CryptonosShop_bot"]);
  await expect(page.locator("iframe")).toHaveCount(0);
  await page
    .locator(".rada-launcher-browser .rada-app-tile")
    .first()
    .click({ delay: 700 });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveClass(/rada-launcher-editor/);
  await expect(dialog).toHaveCSS("border-radius", "0px");
  await expect(
    dialog.locator(".rada-launcher-editor-label .rada-app-tile-art").first(),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "SPLASH: Move later", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const firstHandle = dialog.getByRole("button", {
    name: "DAO",
    exact: true,
  });
  const secondHandle = dialog.getByRole("button", {
    name: "SPLASH",
    exact: true,
  });
  await firstHandle.scrollIntoViewIfNeeded();
  const from = await firstHandle.boundingBox(),
    to = await secondHandle.boundingBox();
  if (!from || !to) throw new Error("Drag handles unavailable");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  await expect(
    dialog.getByRole("button", { name: "SPLASH: Move earlier", exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: "SPLASH: Move later", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Favourite", exact: true })
    .first()
    .click();
  await dialog
    .getByRole("button", { name: "Pin", exact: true })
    .first()
    .click();
  await dialog.getByRole("textbox", { name: "Folder name" }).fill("Weekly");
  await dialog
    .getByRole("button", { name: "Create folder", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "DAO: Move to", exact: true })
    .selectOption({ label: "Weekly" });
  await dialog
    .getByRole("button", { name: "Save layout", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(snapshot.version).toBe(1);
  expect(snapshot.layout.favourites).toEqual(["builtin:governance"]);
  expect(snapshot.layout.pinned).toEqual(["builtin:governance"]);
  expect(snapshot.layout.order[0]).toBe("builtin:governance");
  expect(snapshot.layout.folders[0]?.apps).toEqual(["builtin:governance"]);
  await page.getByRole("button", { name: "Weekly", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveClass(/rada-launcher-folder/);
  await expect(page.getByRole("dialog")).toHaveCSS("border-radius", "0px");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "DAO", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("launcher-home.png") });
  conflict = true;
  await page.getByRole("button", { name: "Arrange apps", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save layout", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Your layout changed elsewhere. Reload before saving.",
  );
  conflict = false;
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Save layout", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("textbox", { name: "Folder name" })
    .first()
    .fill("Personal");
  await dialog.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Folder name" }).first(),
  ).toHaveValue("Personal");
  await dialog
    .getByRole("combobox", { name: "DAO: Move to", exact: true })
    .selectOption("");
  await dialog
    .getByRole("button", { name: "Delete folder", exact: true })
    .click();
  await expect(
    dialog.getByRole("combobox", { name: "DAO: Move to", exact: true }),
  ).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Reset layout", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save layout", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(snapshot.layout).toEqual(emptyLayout());
});
