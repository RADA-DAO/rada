import { test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { t } from "../../../packages/i18n/src/index.ts";

export const artifact = `<main id="artifact">Home fixture app</main>`;
export const sha256 = createHash("sha256").update(artifact).digest("hex");
export const release = (appId: string, name: string, tier: string) => ({
  appId,
  registryId: "00000000-0000-4000-8000-000000000001",
  versionId: "00000000-0000-4000-8000-000000000002",
  versionNo: 1,
  tier,
  manifest: {
    name,
    author: "Fixture author",
    designRoute: "standard",
    permissions: ["identity.self.read"],
    minPlatformVersion: "1.0.0",
  },
  sha256,
  artifactUrl: `https://artifacts.example/artifacts/${sha256}.html`,
  grantedPermissions: ["identity.self.read"],
});
export const published = [
  release("fixture.governance", "Governance fixture", "official"),
  {
    ...release("fixture.game", "Game fixture", "community"),
    manifest: {
      ...release("fixture.game", "Game fixture", "community").manifest,
      category: "games",
    },
  },
];

/** Telegram stand-in; `initData` empty means a guest launch. */
export async function launch(page: Page, initData = "synthetic-home-fixture") {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.addInitScript((initData) => {
    if (window !== window.top) return;
    const listeners = new Map<string, () => void>();
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData,
          ready() {},
          expand() {},
          onEvent() {},
          offEvent() {},
          BackButton: {
            show() {},
            hide() {},
            onClick: (cb: () => void) => listeners.set("back", cb),
            offClick: () => listeners.delete("back"),
          },
        },
      },
      fixtureHost: { back: () => listeners.get("back")?.() },
    });
  }, initData);
  await page.goto("/");
}
export const pressBack = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { fixtureHost: { back(): void } }).fixtureHost.back();
  });
export const appsHeading = (page: Page) =>
  page.getByRole("heading", { name: "Apps", exact: true });
export const tile = (page: Page, name: string) =>
  page
    .getByRole("list", { name: t("en", "home.gridLabel") })
    .getByRole("button", { name, exact: true });

export const ownProfile = (profile: unknown) => ({
  subject_id: "00000000-0000-4000-8000-000000000101",
  profile,
  membership: { status: "unavailable" },
});

export function installHomeFixtures() {
  test.beforeEach(async ({ page }) => {
    await page.route("**/apps/launcher/layout", (route) =>
      route.fulfill({
        json: {
          version: 0,
          layout: { order: [], pinned: [], favourites: [], folders: [] },
        },
      }),
    );
    await page.route("**/apps/launcher/activity", (route) =>
      route.fulfill({ json: { recent: [], popular: [] } }),
    );
    page.on("pageerror", (error) => {
      throw error;
    });
    await page.route("**/me", (route) =>
      route.fulfill({
        json: ownProfile({ visibility: "private", public: null }),
      }),
    );
    await page.route("https://artifacts.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: { "access-control-allow-origin": "*" },
        body: artifact,
      }),
    );
  });
}
