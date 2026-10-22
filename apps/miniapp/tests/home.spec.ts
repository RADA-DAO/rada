import { test, expect } from "@playwright/test";
import { t } from "../../../packages/i18n/src/index.ts";
import {
  sha256,
  release,
  published,
  launch,
  pressBack,
  appsHeading,
  tile,
  ownProfile,
  installHomeFixtures,
} from "./home-fixture.ts";
installHomeFixtures();
test("home lists approved apps with tier marks and opens one onto the stack", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await launch(page);
  await expect(appsHeading(page)).toBeVisible();
  await expect(page.locator(".rada-os-wordmark")).toBeVisible();
  const grid = page.getByRole("list", { name: t("en", "home.gridLabel") });
  await expect(grid.getByRole("listitem")).toHaveCount(11);
  for (const name of ["Holders", "DAO", "Treasury"]) {
    await expect(tile(page, name)).toBeVisible();
    await expect(tile(page, name)).toHaveAccessibleDescription("");
  }
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
    await expect(grid.getByRole("listitem")).toHaveCount(11);
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
  // Built-in SPLASH and platform Holders, Treasury and DAO tiles remain.
  await expect(page.getByRole("listitem")).toHaveCount(9);
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
  await expect(page.locator(".rada-os-wordmark")).toBeVisible();
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
  await expect(page.locator(".rada-os-wordmark")).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("--theme-base", "#123456");
  expect(reads).toBe(1);
});

test("home keeps its launcher when the profile cannot be read", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  await page.route("**/me", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await launch(page);
  await expect(page.locator(".rada-os-wordmark")).toBeVisible();
  await expect(page.getByRole("listitem")).toHaveCount(11);
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

test("secondary screens load on demand and return home through the stack", async ({
  page,
}) => {
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") chunks.push(request.url());
  });
  await launch(page, "");
  await expect(appsHeading(page)).toBeVisible();
  expect(chunks.some((url) => /holders-|desktop-screens-/.test(url))).toBe(
    false,
  );
  for (const name of ["DAO", "Holders", "SPLASH"]) {
    for (const method of ["back", "escape", "swipe"] as const) {
      await tile(page, name).click();
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(t("en", "common.loading"), { exact: true }),
      ).toHaveCount(0);
      if (method === "back") await pressBack(page);
      else if (method === "escape") await page.keyboard.press("Escape");
      else {
        const bounds = await page.locator(".screen").boundingBox();
        if (!bounds) throw new Error("Screen bounds unavailable");
        await page.mouse.move(bounds.x + 12, bounds.y + 60);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.85, bounds.y + 64, {
          steps: 12,
        });
        await page.mouse.up();
      }
      await expect(appsHeading(page)).toBeVisible();
    }
  }
  expect(chunks.some((url) => /desktop-screens-/.test(url))).toBe(true);
});

test("a failed screen chunk offers retry and pending imports cannot replace home", async ({
  page,
}) => {
  let release: (() => void) | undefined;
  await page.route("**/assets/desktop-screens-*.js*", async (route) => {
    // Fail both the module preload and import; only an explicit retry may proceed.
    if (!new URL(route.request().url()).searchParams.has("retry")) {
      await route.abort();
    } else {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.continue();
    }
  });
  await launch(page, "");
  await tile(page, "Holders").click();
  await expect(
    page.getByRole("button", { name: t("en", "common.retry"), exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: t("en", "common.retry"), exact: true })
    .click();
  await expect(
    page.getByText(t("en", "common.loading"), { exact: true }),
  ).toBeVisible();
  await expect.poll(() => Boolean(release)).toBe(true);
  await pressBack(page);
  release?.();
  await expect(appsHeading(page)).toBeVisible();
  await tile(page, "Holders").click();
  await expect(
    page.getByRole("heading", { name: "Holders", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(t("en", "common.loading"), { exact: true }),
  ).toHaveCount(0);
  await pressBack(page);
  await expect(appsHeading(page)).toBeVisible();
});

test("community host loads on launch and retries a failed chunk", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  const chunks: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") chunks.push(request.url());
  });
  let fail = true;
  await page.route("**/assets/community-app-*.js*", (route) => {
    if (fail) {
      fail = false;
      return route.abort();
    }
    return route.continue();
  });
  await launch(page);
  await expect(tile(page, "Game fixture")).toBeVisible();
  expect(
    chunks.some((url) => /community-app-|app-capabilities-|review-/.test(url)),
  ).toBe(false);
  await tile(page, "Game fixture").click();
  await expect(
    page.getByText(t("en", "home.openFailed", { app: "Game fixture" })),
  ).toBeVisible();
  await tile(page, "Game fixture").click();
  await expect(page.locator("iframe")).toHaveCount(1);
  expect(chunks.some((url) => /community-app-.*retry=1/.test(url))).toBe(true);
});

test("Back during community host loading prevents a late mount", async ({
  page,
}) => {
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: published } }),
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  await page.route("**/assets/community-app-*.js*", async (route) => {
    requested();
    await pending;
    await route.continue();
  });
  await launch(page);
  await tile(page, "Game fixture").click();
  await started;
  await pressBack(page);
  await expect(appsHeading(page)).toBeVisible();
  release();
  await page.waitForLoadState("networkidle");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(appsHeading(page)).toBeVisible();
});
