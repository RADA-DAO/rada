import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { createPostgresFixtureRuntime } from "./reputation/postgres-fixture.ts";
import { browserServer } from "./reputation/browser-server.ts";
import { reportReloadRecovery } from "./reputation/browser-recovery.ts";
import { launch } from "../apps/miniapp/tests/home-fixture.ts";
import { signedLaunch } from "../apps/miniapp/tests/telegram-fixture.ts";
import { createTranslator } from "../packages/i18n/src/index.ts";
import en from "../packages/i18n/locales/en.reputation.json" with { type: "json" };
import uk from "../packages/i18n/locales/uk.reputation.json" with { type: "json" };
const translate = createTranslator({ en, uk });

assert.ok(process.env.PG_TEST_URL, "Disposable PG_TEST_URL required");
const runtime = await createPostgresFixtureRuntime(process.env.PG_TEST_URL);
const server = await browserServer(runtime);
const output = "test-results/reputation";
await mkdir(output, { recursive: true });
try {
  const fixture = await runtime.fixture();
  const mission = await fixture.seedMission({
    points: "0.25",
    verifier: "acknowledgement",
  });
  const external = await fixture.seedMission({
    points: "0.5",
    verifier: "external",
  });
  // These fixtures are the only missions in this fresh browser-test database.
  for (const [engine, type] of [
    ["chromium", chromium],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch({ headless: true });
    try {
      for (const { width, locale } of [
        { width: 390, locale: "en" },
        { width: 1280, locale: "en" },
        { width: 390, locale: "uk" },
      ] as const) {
        const text = (key: Parameters<typeof translate>[1]) =>
          translate(locale, key);
        const context = await browser.newContext({
          baseURL: server.origin,
          viewport: { width, height: 844 },
          locale,
        });
        const page = await context.newPage();
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "share", {
            configurable: true,
            value: (data: { text: string }) => {
              Object.assign(window, { syntheticShare: data.text });
              return Promise.resolve();
            },
          });
        });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
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
          await page.route("**/apps/published", (route) =>
            route.fulfill({ json: { apps: [] } }),
          );
          await launch(page, signedLaunch());
          await page
            .getByRole("button", { name: text("tasks"), exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: text("tasks"), exact: true }),
          ).toBeVisible();
          await expect(page.locator(".rada-reputation-task")).toHaveCount(2);
          const before = await runtime.store.summary("101", "today");
          const acknowledgement = page.getByRole("button", {
            name: text("acknowledge"),
            exact: true,
          });
          if (await acknowledgement.count()) {
            const started = Date.now();
            await acknowledgement.click();
            await expect(
              page.getByText(text("confirmed"), {
                exact: true,
              }),
            ).toBeVisible();
            await expect(page.locator(".rada-reputation-total")).toHaveText(
              locale === "uk" ? "0,25 REP" : "0.25 REP",
            );
            assert.ok(
              Date.now() - started < 3000,
              "local confirmation exceeded functional timeout",
            );
          } else assert.equal(before.totalPoints, "0.25");
          const after = await runtime.store.summary("101", "today");
          assert.equal(after.totalPoints, "0.25");
          await page
            .getByRole("button", { name: text("share.action"), exact: true })
            .click();
          const shared = await page.evaluate(
            () =>
              (window as unknown as { syntheticShare: string }).syntheticShare,
          );
          assert.ok(
            shared.includes("0.25") &&
              !shared.includes("auth_date") &&
              !shared.includes(mission.id),
          );
          if (width === 390 && locale === "en")
            await reportReloadRecovery(page, runtime.store, engine);
          await page.screenshot({
            path: `${output}/${engine}-${locale}-${String(width)}-tasks.png`,
            fullPage: true,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > window.innerWidth,
            ),
            false,
          );
          await page
            .getByRole("button", { name: text("title"), exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: text("title"), exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", {
              name: text("period.previous_week"),
              exact: true,
            })
            .click();
          await expect(page.locator(".rada-reputation-total")).toHaveText(
            "0 REP",
          );
          await page
            .getByRole("button", { name: text("period.today"), exact: true })
            .click();
          await expect(page.locator(".rada-reputation-total")).toHaveText(
            locale === "uk" ? "0,25 REP" : "0.25 REP",
          );
          await page.screenshot({
            path: `${output}/${engine}-${locale}-${String(width)}-history.png`,
            fullPage: true,
          });
          await page
            .getByRole("button", {
              name: /Synthetic acknowledgement · 0[,.]25 REP/,
            })
            .click();
          await page
            .getByRole("button", { name: text("appeal.open"), exact: true })
            .click();
          const dialog = page.getByRole("dialog");
          await dialog
            .getByLabel(text("appeal.message"), { exact: true })
            .fill(`Synthetic ${engine} ${locale} ${String(width)} review`);
          await dialog
            .getByRole("button", { name: text("submit"), exact: true })
            .click();
          await expect(dialog).toHaveCount(0);
          await expect(
            page.getByText(
              `Synthetic ${engine} ${locale} ${String(width)} review`,
              {
                exact: true,
              },
            ),
          ).toBeVisible();
          assert.equal(
            (await runtime.store.summary("101", "today")).totalPoints,
            "0.25",
          );
          await page.screenshot({
            path: `${output}/${engine}-${locale}-${String(width)}-detail.png`,
            fullPage: true,
          });
          assert.deepEqual(errors, []);
        } catch (error) {
          await page
            .screenshot({
              path: `${output}/${engine}-${locale}-${String(width)}-failure.png`,
              fullPage: true,
            })
            .catch(() => undefined);
          throw error;
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
  }
  // Unknown delivery: commit, discard HTTP response, recover by original request.
  const requestId = crypto.randomUUID();
  const completed = await runtime.store.verify("101", mission.id, {
    requestId,
    missionVersion: mission.version,
  });
  const response = await fetch(
    `${server.origin}/api/v1/reputation/commands/${requestId}`,
    { headers: { Authorization: `tma ${signedLaunch()}` } },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completed);
  const unauthorized = await fetch(
    `${server.origin}/api/v1/reputation/summary`,
  );
  assert.equal(unauthorized.status, 401);
  const pending = await runtime.store.verify("101", external.id, {
    requestId: crypto.randomUUID(),
    missionVersion: external.version,
  });
  assert.equal(pending.state, "checking");
  assert.equal(
    (await runtime.store.summary("101", "today")).totalPoints,
    "0.25",
  );
  assert.deepEqual(server.failures, []);
  process.stdout.write(
    JSON.stringify({
      browsers: ["chromium", "webkit"],
      widths: [390, 1280],
      output,
      status: "passed",
    }),
  );
} finally {
  await server.close();
  await runtime.close();
}
