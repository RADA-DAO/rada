import { test, expect } from "@playwright/test";
import { t } from "../../../packages/i18n/src/index.ts";
import { launch, installHomeFixtures } from "./home-fixture.ts";
installHomeFixtures();

test("guest entry shares its configured link and recovers from clipboard denial", async ({
  page,
}) => {
  await launch(page, "");
  const entry = "https://t.me/rada_fixture_bot/app";
  await page.getByText(t("en", "home.guestOtherDevice")).click();
  await expect(
    page.getByRole("textbox", { name: t("en", "home.guestLink") }),
  ).toHaveValue(entry);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          document.documentElement.dataset.copied = value;
          return Promise.resolve();
        },
      },
    });
  });
  await page
    .getByRole("button", { name: t("en", "home.guestCopy"), exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    t("en", "home.guestCopied"),
  );
  await expect(page.locator("html")).toHaveAttribute("data-copied", entry);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          return Promise.reject(new Error("denied"));
        },
      },
    });
  });
  await page.getByText(t("en", "home.guestOtherDevice")).click();
  await page
    .getByRole("button", { name: t("en", "home.guestCopy"), exact: true })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    t("en", "home.guestCopyFallback"),
  );
  await expect(
    page.getByRole("textbox", { name: t("en", "home.guestLink") }),
  ).toBeFocused();
});
