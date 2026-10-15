import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import pg from "pg";
import { createHash } from "node:crypto";
import { t } from "../../../packages/i18n/src/index.ts";
import enLocale from "../../../packages/i18n/locales/en.json" with { type: "json" };
import ukLocale from "../../../packages/i18n/locales/uk.json" with { type: "json" };
function signed(age = 0) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id: 101 }),
  });
  const secret = createHmac("sha256", "WebAppData")
    .update("synthetic-fixture-bot-token")
    .digest();
  data.set(
    "hash",
    createHmac("sha256", secret)
      .update(
        [...data.entries()]
          .sort()
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      )
      .digest("hex"),
  );
  return data.toString();
}
async function host(page: Page, initData = "") {
  await page.addInitScript(
    ({ initData }) => {
      const listeners = new Map<string, () => void>();
      const webApp = {
        initData,
        viewportHeight: innerHeight,
        safeAreaInset: { top: 12, bottom: 20 },
        contentSafeAreaInset: { top: 8 },
        ready() {},
        expand() {},
        setHeaderColor() {},
        setBackgroundColor() {},
        onEvent(name: string, cb: () => void) {
          listeners.set(name, cb);
        },
        offEvent(name: string) {
          listeners.delete(name);
        },
        BackButton: {
          show() {},
          hide() {},
          onClick(cb: () => void) {
            listeners.set("back", cb);
          },
          offClick() {
            listeners.delete("back");
          },
        },
      };
      Object.assign(window, {
        Telegram: { WebApp: webApp },
        fixtureHost: {
          back: () => listeners.get("back")?.(),
          resize: (height: number) => {
            webApp.viewportHeight = height;
            listeners.get("viewportChanged")?.();
          },
        },
      });
    },
    { initData },
  );
}
test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  page.on("pageerror", (error) => {
    throw error;
  });
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("401 (Unauthorized)")
    )
      throw new Error(message.text());
  });
});
test("verified opaque app requests consent through host and self-only API", async ({
  page,
}, testInfo) => {
  const appId = `fixture.${testInfo.project.name}.${Date.now()}`;
  const token = signed();
  await host(page, token);
  await page.goto("/");
  const artifact = `<main id="artifact">Sandbox app<button id="child-back">Back</button></main><script>
    document.body.dataset.origin = location.origin;
    document.querySelector('#child-back').onclick = () => rada.member.back();
    rada.member.request('rada.member.context.get').then(value => { document.body.dataset.locale = value.locale; });
    rada.member.request('rada.member.permission.request', { permission: 'wallet.address.read' })
      .then(value => { document.body.dataset.granted = String(value.granted); });
    rada.member.request('rada.member.money.transfer', { amount: 1 })
      .catch(error => { document.body.dataset.money = error.message; });
  </script>`;
  const hash = createHash("sha256").update(artifact).digest("hex");
  await page.route("**/fixture-app.html", (route) =>
    route.fulfill({ contentType: "text/html", body: artifact }),
  );
  await page.evaluate(
    async ({ hash, appId }) => {
      const holder = document.createElement("div");
      document.body.append(holder);
      const fixture = window as unknown as {
        RadaAppHost: {
          mount(
            release: unknown,
            holder: HTMLElement,
            origin: string,
          ): Promise<() => void>;
        };
        fixtureDispose?: () => void;
      };
      fixture.fixtureDispose = await fixture.RadaAppHost.mount(
        {
          appId,
          artifactUrl: "http://127.0.0.1:4173/fixture-app.html",
          artifactSha256: hash,
          manifest: {
            name: "Fixture",
            author: "Fixture",
            trustLevel: "official",
            designRoute: "free-style",
            permissions: [
              "wallet.address.read",
              "money.transfer",
              "navigation",
            ],
            minPlatformVersion: "1.0.0",
          },
          grantedPermissions: [
            "wallet.address.read",
            "money.transfer",
            "navigation",
          ],
        },
        holder,
        "http://127.0.0.1:4173",
      );
    },
    { hash, appId },
  );
  const frame = page.frameLocator("iframe[sandbox='allow-scripts']");
  await expect(
    page.getByRole("dialog", { name: enLocale.shell.consentTitle }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(frame.locator("body")).toHaveAttribute("data-granted", "true");
  await expect(frame.locator("body")).toHaveAttribute(
    "data-money",
    "capability_denied",
  );
  await expect(frame.locator("body")).toHaveAttribute("data-origin", "null");
  await expect(frame.locator("body")).toHaveAttribute("data-locale", "en");
  const database = new pg.Pool({
    connectionString: process.env.E2E_DATABASE_URL,
  });
  try {
    const result = await database.query(
      "SELECT app_id, capability FROM identity.consents WHERE app_id = $1 AND revoked_at IS NULL",
      [appId],
    );
    expect(result.rows).toEqual([
      { app_id: appId, capability: "wallet.address.read" },
    ]);
  } finally {
    await database.end();
  }
  await frame.locator("#child-back").click();
  await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(0);
});
test("opaque app cannot fetch, navigate externally or self-grant declared authority", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  // Expected CSP violations are part of this negative test.
  page.removeAllListeners("console");
  let networkHits = 0;
  await page.route("**/blocked-*", (route) => {
    networkHits++;
    return route.fulfill({ body: "unexpected" });
  });
  const artifact = `<main id="hostile">Contained<button id="navigate">Navigate</button></main><script>
    try { parent.document; document.body.dataset.parent = 'open'; } catch { document.body.dataset.parent = 'blocked'; }
    fetch('http://127.0.0.1:4173/blocked-fetch').then(() => document.body.dataset.fetch = 'open').catch(() => document.body.dataset.fetch = 'blocked');
    rada.member.request('rada.member.identity.self').then(() => document.body.dataset.grant = 'open').catch(error => document.body.dataset.grant = error.message);
    document.querySelector('#navigate').onclick = () => { location.href = 'http://127.0.0.1:4173/blocked-navigation'; };
  </script>`;
  const hash = createHash("sha256").update(artifact).digest("hex");
  await page.route("**/hostile-app.html", (route) =>
    route.fulfill({ contentType: "text/html", body: artifact }),
  );
  await page.evaluate(
    async ({ hash }) => {
      const holder = document.createElement("div");
      document.body.append(holder);
      await window.RadaAppHost!.mount(
        {
          appId: "fixture.hostile",
          artifactUrl: "http://127.0.0.1:4173/hostile-app.html",
          artifactSha256: hash,
          manifest: {
            name: "Fixture",
            author: "Fixture",
            trustLevel: "official",
            designRoute: "free-style",
            permissions: ["identity.self.read"],
            minPlatformVersion: "1.0.0",
          },
          grantedPermissions: [],
        },
        holder,
        "http://127.0.0.1:4173",
      );
    },
    { hash },
  );
  const frame = page.frameLocator("iframe[sandbox='allow-scripts']");
  await expect(frame.locator("#hostile")).toBeVisible();
  await expect(frame.locator("body")).toHaveAttribute("data-parent", "blocked");
  await expect(frame.locator("body")).toHaveAttribute("data-fetch", "blocked");
  await expect(frame.locator("body")).toHaveAttribute(
    "data-grant",
    "capability_denied",
  );
  await frame.locator("#navigate").click();
  await page.waitForTimeout(200);
  expect(networkHits).toBe(0);
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
});

test("closing an app cancels its unanswered permission dialog", async ({
  page,
}, testInfo) => {
  await host(page, signed());
  await page.goto("/");
  let writes = 0;
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().endsWith("/me/consents"))
      writes++;
  });
  const artifact = `<script>
    rada.member.request('rada.member.permission.request', { permission: 'wallet.address.read' }).catch(() => {});
    rada.member.request('rada.member.permission.request', { permission: 'wallet.address.read' })
      .catch(error => { document.body.dataset.second = error.message; });
  </script>`;
  const hash = createHash("sha256").update(artifact).digest("hex");
  await page.route("**/dispose-app.html", (route) =>
    route.fulfill({ contentType: "text/html", body: artifact }),
  );
  await page.evaluate(
    async ({ hash, appId }) => {
      const holder = document.createElement("div");
      document.body.append(holder);
      (window as Window & { fixtureDispose?: () => void }).fixtureDispose =
        await window.RadaAppHost!.mount(
          {
            appId,
            artifactUrl: "http://127.0.0.1:4173/dispose-app.html",
            artifactSha256: hash,
            manifest: {
              name: "Fixture",
              author: "Fixture",
              trustLevel: "community",
              designRoute: "standard",
              permissions: ["wallet.address.read"],
              minPlatformVersion: "1.0.0",
            },
            grantedPermissions: ["wallet.address.read"],
          },
          holder,
          "http://127.0.0.1:4173",
        );
    },
    { hash, appId: `fixture.dispose.${testInfo.project.name}` },
  );
  await expect(
    page.getByRole("dialog", { name: enLocale.shell.consentTitle }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page.frameLocator("iframe[sandbox='allow-scripts']").locator("body"),
  ).toHaveAttribute("data-second", "rate_limited");
  await page.evaluate(() =>
    (window as unknown as { fixtureDispose: () => void }).fixtureDispose(),
  );
  await expect(
    page.getByRole("dialog", { name: enLocale.shell.consentTitle }),
  ).toHaveCount(0);
  expect(writes).toBe(0);
});
test("timed-out bridge calls release capacity even when identity fetch hangs", async ({
  page,
}) => {
  await page.clock.install();
  await host(page, signed());
  await page.goto("/");
  const held: import("@playwright/test").Route[] = [];
  await page.route("**/me", (route) => {
    held.push(route);
  });
  const artifact = `<script>
    Promise.allSettled(Array.from({ length: 4 }, () => rada.member.request('rada.member.identity.self')))
      .then(() => setTimeout(() => rada.member.request('rada.member.money.transfer')
        .catch(error => { document.body.dataset.afterTimeout = error.message; }), 500));
  </script>`;
  const hash = createHash("sha256").update(artifact).digest("hex");
  await page.route("**/timeout-app.html", (route) =>
    route.fulfill({ contentType: "text/html", body: artifact }),
  );
  await page.evaluate(async (hash) => {
    const holder = document.createElement("div");
    document.body.append(holder);
    (window as Window & { fixtureDispose?: () => void }).fixtureDispose =
      await window.RadaAppHost!.mount(
        {
          appId: "fixture.timeout",
          artifactUrl: "http://127.0.0.1:4173/timeout-app.html",
          artifactSha256: hash,
          manifest: {
            name: "Fixture",
            author: "Fixture",
            trustLevel: "community",
            designRoute: "standard",
            permissions: ["identity.self.read"],
            minPlatformVersion: "1.0.0",
          },
          grantedPermissions: ["identity.self.read"],
        },
        holder,
        "http://127.0.0.1:4173",
      );
  }, hash);
  await expect.poll(() => held.length).toBe(4);
  await page.clock.fastForward(10100);
  await page.clock.runFor(600);
  await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
    "data-after-timeout",
    "capability_denied",
  );
  await page.evaluate(() =>
    (window as unknown as { fixtureDispose: () => void }).fixtureDispose(),
  );
  await Promise.all(
    held.map((route) =>
      route
        .fulfill({
          json: {
            subject_id: "00000000-0000-4000-8000-000000000101",
            profile: { visibility: "private", public: null },
            membership: { status: "unavailable" },
          },
        })
        .catch(() => {}),
    ),
  );
});

test("a replaced artifact fetch cannot remove the current app", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  let slowRoute: import("@playwright/test").Route | undefined;
  const slow = '<main id="stale-artifact">Stale</main>';
  const current = '<main id="current-artifact">Current</main>';
  await page.route("**/slow-app.html", (route) => {
    slowRoute = route;
  });
  await page.route("**/current-app.html", (route) =>
    route.fulfill({ contentType: "text/html", body: current }),
  );
  const hashes = [slow, current].map((body) =>
    createHash("sha256").update(body).digest("hex"),
  );
  await page.evaluate((hashes) => {
    const holder = document.createElement("div");
    holder.id = "fixture-holder";
    document.body.append(holder);
    const fixture = window as Window & { slowOutcome?: Promise<string> };
    fixture.slowOutcome = window
      .RadaAppHost!.mount(
        {
          appId: "fixture.slow",
          artifactUrl: "http://127.0.0.1:4173/slow-app.html",
          artifactSha256: hashes[0],
          manifest: {
            name: "Fixture",
            author: "Fixture",
            trustLevel: "community",
            designRoute: "standard",
            permissions: [],
            minPlatformVersion: "1.0.0",
          },
          grantedPermissions: [],
        },
        holder,
        "http://127.0.0.1:4173",
      )
      .then(
        () => "mounted",
        () => "cancelled",
      );
  }, hashes);
  await expect.poll(() => Boolean(slowRoute)).toBe(true);
  await page.evaluate(async (hashes) => {
    await window.RadaAppHost!.mount(
      {
        appId: "fixture.current",
        artifactUrl: "http://127.0.0.1:4173/current-app.html",
        artifactSha256: hashes[1],
        manifest: {
          name: "Fixture",
          author: "Fixture",
          trustLevel: "community",
          designRoute: "standard",
          permissions: [],
          minPlatformVersion: "1.0.0",
        },
        grantedPermissions: [],
      },
      document.querySelector<HTMLElement>("#fixture-holder")!,
      "http://127.0.0.1:4173",
    );
  }, hashes);
  await slowRoute!
    .fulfill({ contentType: "text/html", body: slow })
    .catch(() => {});
  expect(
    await page.evaluate(
      () => (window as unknown as { slowOutcome: Promise<string> }).slowOutcome,
    ),
  ).toBe("cancelled");
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(
    page.frameLocator("iframe").locator("#current-artifact"),
  ).toBeVisible();
});

test("guest navigation, settings focus, locale and native Back", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveCSS("--app-safe-top", "20px");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(page.getByText("Guest profile", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { fixtureHost: { back(): void } }).fixtureHost.back(),
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox").selectOption("uk");
  await expect(page.locator("html")).toHaveAttribute("lang", "uk");
  await page
    .getByRole("button", { name: t("uk", "common.close"), exact: true })
    .click();
  await page.evaluate(() =>
    (window as unknown as { fixtureHost: { back(): void } }).fixtureHost.back(),
  );
  await expect(
    page.getByRole("heading", { name: t("uk", "shell.apps"), exact: true }),
  ).toBeVisible();
});
test("keyboard overlay and layout resize preserve field and dismiss without submit", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    const field = document.createElement("input");
    field.inputMode = "numeric";
    field.id = "fixture-field";
    dialog.append(field);
    document.body.append(dialog);
    dialog.showModal();
  });
  const field = page.locator("#fixture-field");
  await field.fill("123");
  await page.evaluate(() =>
    (
      window as unknown as { fixtureHost: { resize(height: number): void } }
    ).fixtureHost.resize(390),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-app-viewport-reduced",
    "true",
  );
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("123");
  await expect(
    page.getByRole("button", { name: "Hide keyboard", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Hide keyboard", exact: true })
    .click();
  await expect(field).not.toBeFocused();
  await page.setViewportSize({ width: 390, height: 440 });
  await page.evaluate(() =>
    (
      window as unknown as { fixtureHost: { resize(height: number): void } }
    ).fixtureHost.resize(440),
  );
  await field.focus();
  await field.press("Enter");
  await expect(field).not.toBeFocused();
  await expect(field).toHaveValue("123");
});
test("real API and PostgreSQL follow selected frog ownership", async ({
  page,
}) => {
  test.skip(
    !process.env.E2E_DATABASE_URL,
    "Requires isolated PostgreSQL integration environment",
  );
  await host(page, signed());
  await page.goto("/");
  const responsePromise = page.waitForResponse((r) => r.url().endsWith("/me"));
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  const me = await response.json();
  expect(me.profile).toEqual({ visibility: "private", public: null });
  await expect(
    page.getByText("Private profile", { exact: true }),
  ).toBeVisible();
  const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  try {
    const result = await db.query(
      "SELECT subject_id FROM identity.telegram_accounts WHERE telegram_user_id = 101",
    );
    expect(result.rows[0].subject_id).toBe(me.subject_id);
    const frogId = crypto.randomUUID();
    const username = `Fixture_${frogId.replaceAll("-", "").slice(0, 12)}`;
    await db.query(
      "SELECT jpegpe.create_frog($1::uuid, $2, $3::uuid, $4, $5)",
      [frogId, username, me.subject_id, "#123456", "#ABCDEF"],
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        me.subject_id,
      ]);
      expect(
        (
          await client.query(
            "SELECT identity.select_frog($1::uuid) AS selected",
            [frogId],
          )
        ).rows[0].selected,
      ).toBe(true);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(
      page.getByText("Public profile", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(username.toUpperCase(), { exact: true }),
    ).toBeVisible();
    const recipient = (
      await db.query("SELECT identity.resolve_telegram(102) AS subject_id")
    ).rows[0].subject_id;
    await db.query(
      "SELECT jpegpe.transfer_frog($1::uuid, $2::uuid, $3::uuid)",
      [frogId, me.subject_id, recipient],
    );
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(
      page.getByText("Private profile", { exact: true }),
    ).toBeVisible();
  } finally {
    await db.end();
  }
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  expect(await page.content()).not.toContain("synthetic-fixture-bot-token");
});
test("profile projects each validated membership status and refreshes on click", async ({
  page,
}) => {
  await host(page, signed());
  let status: unknown = "member";
  let profilePayload: unknown = { visibility: "private", public: null };
  let responseExtras: Record<string, unknown> = {};
  let membershipExtras: Record<string, unknown> = {};
  let requests = 0;
  await page.route("**/me", (route) => {
    requests++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subject_id: "fixture-subject",
        profile: profilePayload,
        membership: { status, ...membershipExtras },
        ...responseExtras,
      }),
    });
  });
  await page.goto("/");
  const profile = page.getByRole("button", { name: "Profile", exact: true });
  const projected = [
    ["member", enLocale.shell.membership.member],
    ["not_member", enLocale.shell.membership.not_member],
    ["unavailable", enLocale.shell.membership.unavailable],
  ] as const;
  for (const [value, label] of projected) {
    status = value;
    await profile.click();
    await expect(page.getByText(label, { exact: true })).toBeVisible();
    if (value !== "unavailable")
      await expect(
        page.getByText(enLocale.shell.private, { exact: true }),
      ).toBeVisible();
    await page
      .getByRole("button", { name: enLocale.shell.apps, exact: true })
      .click();
  }
  expect(requests).toBe(3);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox").selectOption("uk");
  await page
    .getByRole("button", { name: t("uk", "common.close"), exact: true })
    .click();
  status = "member";
  await page
    .getByRole("button", { name: ukLocale.shell.profile, exact: true })
    .click();
  await expect(
    page.getByText(ukLocale.shell.membership.member, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: ukLocale.shell.apps, exact: true })
    .click();
  profilePayload = {
    visibility: "public",
    public: {
      frog_id: "00000000-0000-4000-8000-000000000001",
      username: "Invalid name",
      background_color: "#123456",
      accent_color: null,
    },
  };
  await page
    .getByRole("button", { name: ukLocale.shell.profile, exact: true })
    .click();
  await expect(
    page.getByText(ukLocale.shell.unavailable, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: ukLocale.shell.apps, exact: true })
    .click();
  profilePayload = { visibility: "private", public: null };
  for (const scope of ["profile", "response", "membership"] as const) {
    if (scope === "profile")
      profilePayload = {
        visibility: "private",
        public: null,
        telegram_user_id: "private-fixture",
      };
    if (scope === "response")
      responseExtras = { telegram_user_id: "private-fixture" };
    if (scope === "membership")
      membershipExtras = { telegram_user_id: "private-fixture" };
    await page
      .getByRole("button", { name: ukLocale.shell.profile, exact: true })
      .click();
    await expect(
      page.getByText(ukLocale.shell.unavailable, { exact: true }),
    ).toBeVisible();
    expect(await page.content()).not.toContain("private-fixture");
    await page
      .getByRole("button", { name: ukLocale.shell.apps, exact: true })
      .click();
    profilePayload = { visibility: "private", public: null };
    responseExtras = {};
    membershipExtras = {};
  }
  for (const malformed of ["unexpected", ["member"]]) {
    status = malformed;
    await page
      .getByRole("button", { name: ukLocale.shell.profile, exact: true })
      .click();
    await expect(
      page.getByText(ukLocale.shell.unavailable, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(enLocale.shell.membership.member, { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: ukLocale.shell.apps, exact: true })
      .click();
  }
});
test("expired authentication has a manual retry", async ({ page }) => {
  test.skip(
    !process.env.E2E_DATABASE_URL,
    "Requires isolated PostgreSQL integration environment",
  );
  await host(page, signed(90000));
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByText("Session expired", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
});

test("swipe and visible Back share the launcher destination", async ({
  page,
}) => {
  await host(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  const bounds = (await page.locator(".screen").boundingBox())!;
  await page.mouse.move(bounds.x + 24, 240);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.85, 245, { steps: 12 });
  await page.mouse.up();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await page.getByRole("button", { name: "Back to apps" }).click();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
});
test("unavailable response can recover with manual retry", async ({ page }) => {
  await host(page, signed());
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let interrupted = false;
    window.fetch = (input, init) => {
      if (!interrupted && String(input).endsWith("/me")) {
        interrupted = true;
        return Promise.reject(
          new TypeError("Synthetic connection interruption"),
        );
      }
      return originalFetch(input, init);
    };
  });
  let attempts = 0;
  await page.route("**/me", (route) => {
    attempts++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subject_id: "fixture-subject",
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      }),
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByText("Profile unavailable", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Private profile", { exact: true }),
  ).toBeVisible();
});
