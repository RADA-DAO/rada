import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, webkit, expect } from "@playwright/test";
import { createPostgresFixtureRuntime } from "./reputation/postgres-fixture.ts";
import { browserServer } from "./reputation/browser-server.ts";
import { launch } from "../apps/miniapp/tests/home-fixture.ts";
import { signedLaunch } from "../apps/miniapp/tests/telegram-fixture.ts";

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
      for (const width of [390, 1280]) {
        const context = await browser.newContext({
          baseURL: server.origin,
          viewport: { width, height: 844 },
          locale: "en-US",
        });
        const page = await context.newPage();
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
            .getByRole("button", { name: "Tasks", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: "Tasks", exact: true }),
          ).toBeVisible();
          const before = await runtime.store.summary("101", "today");
          const acknowledgement = page.getByRole("button", {
            name: "Acknowledge",
            exact: true,
          });
          if (await acknowledgement.count()) {
            const started = Date.now();
            await acknowledgement.click();
            await expect(
              page.getByText("Confirmed. Your REP is up to date.", {
                exact: true,
              }),
            ).toBeVisible();
            await expect(page.locator(".rada-reputation-total")).toHaveText(
              "0.25 REP",
            );
            assert.ok(
              Date.now() - started < 3000,
              "local confirmation exceeded functional timeout",
            );
          } else assert.equal(before.totalPoints, "0.25");
          const after = await runtime.store.summary("101", "today");
          assert.equal(after.totalPoints, "0.25");
          await page.screenshot({
            path: `${output}/${engine}-${String(width)}-tasks.png`,
            fullPage: true,
          });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > window.innerWidth,
            ),
            false,
          );
          await page
            .getByRole("button", { name: "Reputation", exact: true })
            .click();
          await expect(
            page.getByRole("heading", { name: "Reputation", exact: true }),
          ).toBeVisible();
          await page
            .getByRole("button", {
              name: /Synthetic acknowledgement · 0.25 REP/,
            })
            .click();
          await page
            .getByRole("button", { name: "Ask for a review", exact: true })
            .click();
          const dialog = page.getByRole("dialog");
          await dialog
            .getByLabel("What should be reviewed?", { exact: true })
            .fill(`Synthetic ${engine} ${String(width)} review`);
          await dialog
            .getByRole("button", { name: "Submit", exact: true })
            .click();
          await expect(dialog).toHaveCount(0);
          await expect(
            page.getByText(`Synthetic ${engine} ${String(width)} review`, {
              exact: true,
            }),
          ).toBeVisible();
          assert.equal(
            (await runtime.store.summary("101", "today")).totalPoints,
            "0.25",
          );
          await page.screenshot({
            path: `${output}/${engine}-${String(width)}-detail.png`,
            fullPage: true,
          });
          assert.deepEqual(errors, []);
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
