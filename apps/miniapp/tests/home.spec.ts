import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { t } from "../../../packages/i18n/src/index.ts";

const artifact = `<main id="artifact">Home fixture app</main>`;
const sha256 = createHash("sha256").update(artifact).digest("hex");
const release = (appId: string, name: string, tier: string) => ({
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
const published = [
  release("fixture.governance", "Governance fixture", "official"),
  release("fixture.game", "Game fixture", "community"),
];

/** Telegram stand-in; `initData` empty means a guest launch. */
async function launch(page: Page, initData = "synthetic-home-fixture") {
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
const pressBack = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { fixtureHost: { back(): void } }).fixtureHost.back();
  });
const appsHeading = (page: Page) =>
  page.getByRole("heading", { name: "Apps", exact: true });
const tile = (page: Page, name: string) =>
  page
    .getByRole("list", { name: t("en", "home.gridLabel") })
    .getByRole("button", { name, exact: true });

const ownProfile = (profile: unknown) => ({
  subject_id: "00000000-0000-4000-8000-000000000101",
  profile,
  membership: { status: "unavailable" },
});

test.beforeEach(async ({ page }) => {
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

test("home lists approved apps with tier marks and opens one onto the stack", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await launch(page);
  await expect(appsHeading(page)).toBeVisible();
  await expect(
    page.getByText(t("en", "home.identityMember"), { exact: true }),
  ).toBeVisible();
  const grid = page.getByRole("list", { name: t("en", "home.gridLabel") });
  await expect(grid.getByRole("listitem")).toHaveCount(3);
  const official = tile(page, "Governance fixture");
  const community = tile(page, "Game fixture");
  await expect(official).toHaveAccessibleDescription(
    t("en", "home.tier.official"),
  );
  await expect(community).toHaveAccessibleDescription(
    t("en", "home.tier.community"),
  );
  // Focus follows reading order: the first tile, then the next one.
  await official.focus();
  await page.keyboard.press("Tab");
  await expect(community).toBeFocused();

  const frame = page.frameLocator('iframe[title="Governance fixture"]');
  const opened = async () => {
    await expect(
      page.getByRole("heading", { name: "Governance fixture", exact: true }),
    ).toBeVisible();
    await expect(frame.locator("#artifact")).toHaveText("Home fixture app");
    await expect(page.getByRole("navigation")).toHaveCount(0);
  };
  const returned = async () => {
    await expect(appsHeading(page)).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expect(grid.getByRole("listitem")).toHaveCount(3);
  };

  await official.click();
  await opened();
  await pressBack(page);
  await returned();

  await official.click();
  await opened();
  await page.goBack();
  await returned();

  await official.click();
  await opened();
  const title = await page
    .getByRole("heading", { name: "Governance fixture", exact: true })
    .boundingBox();
  const bounds = await page.locator(".screen").boundingBox();
  if (!title || !bounds) throw new Error("Screen bounds unavailable");
  const y = title.y + title.height / 2;
  await page.mouse.move(bounds.x + 12, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.85, y + 4, { steps: 12 });
  await page.mouse.up();
  await returned();
});

test("home shows loading, recovers from an error and shows the empty state", async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  let calls = 0;
  await page.route("**/apps/published", async (route) => {
    calls++;
    if (calls === 1) {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      await route.fulfill({ status: 503, json: { error: "unavailable" } });
      return;
    }
    await route.fulfill({ json: { apps: [] } });
  });
  await launch(page);
  await expect(page.getByText(t("en", "home.loading"))).toBeVisible();
  finish?.();
  await expect(
    page.getByText(t("en", "shell.unavailableDescription")),
  ).toBeVisible();
  await page.getByRole("button", { name: t("en", "common.retry") }).click();
  await expect(page.getByText(t("en", "home.emptyTitle"))).toBeVisible();
  // Only the built-in official SPLASH tile remains.
  await expect(page.getByRole("listitem")).toHaveCount(1);
});

test("a guest sees how to sign in and no catalog request is made", async ({
  page,
}) => {
  let calls = 0;
  await page.route("**/apps/published", (route) => {
    calls++;
    return route.fulfill({ json: { apps: published } });
  });
  await launch(page, "");
  await expect(
    page.getByRole("heading", { name: t("en", "home.guestTitle") }),
  ).toBeVisible();
  await expect(
    page.getByText(t("en", "home.identityGuest"), { exact: true }),
  ).toBeVisible();
  expect(calls).toBe(0);
});

test("an app that fails verification returns home with a retry", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await page.unroute("https://artifacts.example/**");
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      body: "wrong bytes",
    }),
  );
  await launch(page);
  await tile(page, "Game fixture").click();
  const failure = t("en", "home.openFailed", { app: "Game fixture" });
  await expect(page.getByText(failure)).toBeVisible();
  await expect(appsHeading(page)).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(tile(page, "Game fixture")).toBeVisible();
});

test("tier marks follow the viewer's language", async ({ page }) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await launch(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox").selectOption("uk");
  await page
    .getByRole("button", { name: t("uk", "common.close"), exact: true })
    .click();
  await expect(
    page
      .getByRole("list", { name: t("uk", "home.gridLabel") })
      .getByRole("button", { name: "Governance fixture", exact: true }),
  ).toHaveAccessibleDescription(t("uk", "home.tier.official"));
});

test("home shows the viewer's name and frog right after login", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await page.route("**/me", (route) => {
    reads++;
    return route.fulfill({
      json: ownProfile({
        visibility: "public",
        public: {
          frog_id: "00000000-0000-4000-8000-000000000001",
          username: "Fixture_frog",
          background_color: "#123456",
          accent_color: null,
        },
      }),
    });
  });
  await launch(page);
  await expect(page.getByText("Fixture_frog", { exact: true })).toBeVisible();
  await expect(
    page.getByText(t("en", "shell.public"), { exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);
});

test("home keeps a generic identity when the profile cannot be read", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await page.route("**/me", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await launch(page);
  await expect(
    page.getByText(t("en", "home.identityMember"), { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(3);
});

test("a tile shows the approved icon and keeps its monogram when the icon fails", async ({
  page,
}) => {
  const withIcon = (appId: string, name: string, icon: string) => {
    const base = release(appId, name, "community");
    return { ...base, manifest: { ...base.manifest, icon } };
  };
  await page.route("**/apps/published", (route) =>
    route.fulfill({
      json: {
        apps: [
          withIcon("fixture.pictured", "Pictured fixture", "icon.svg"),
          withIcon("fixture.broken", "Broken fixture", "missing.png"),
        ],
      },
    }),
  );
  await page.route(
    `https://artifacts.example/artifacts/${sha256}/*`,
    (route) =>
      route.request().url().endsWith("/icon.svg")
        ? route.fulfill({
            contentType: "image/svg+xml",
            headers: { "access-control-allow-origin": "*" },
            body: "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#2b8a6e'/></svg>",
          })
        : route.fulfill({
            status: 404,
            headers: { "access-control-allow-origin": "*" },
            body: "",
          }),
  );
  await launch(page);
  await expect(tile(page, "Pictured fixture").locator("img")).toBeVisible();
  await expect(tile(page, "Broken fixture").locator("img")).toHaveCount(0);
  await expect(tile(page, "Broken fixture")).toContainText("B");
});
