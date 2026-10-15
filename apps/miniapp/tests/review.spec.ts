import { test, expect, type Page } from "@playwright/test";
import { createHmac, createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { t } from "../../../packages/i18n/src/index.ts";
function signed(id = 102, age = 0) {
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
async function launch(page: Page, token = signed(), enter = true) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
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
  await page.goto("/");
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  if (enter)
    await page.getByRole("button", { name: "App review", exact: true }).click();
}
const manifest = {
  name: "Review fixture",
  author: "Fixture",
  trustLevel: "official",
  designRoute: "free-style",
  permissions: [
    "identity.self.read",
    "wallet.address.read",
    "money.transfer",
    "wallet.sign",
  ],
  minPlatformVersion: "1.0.0",
};
const artifact = `<main>Review sandbox</main><script>
for (const [key,type,payload] of [['identity','rada.member.identity.self',{}],['consent','rada.member.permission.request',{permission:'wallet.address.read'}],['money','rada.member.money.transfer',{}],['signature','rada.member.wallet.sign',{}]]) rada.member.request(type,payload).catch(error=>{document.body.dataset[key]=error.message});
rada.member.request('rada.member.context.get').then(value=>document.body.dataset.locale=value.locale);
</script>`;
const sha256 = createHash("sha256").update(artifact).digest("hex");
const version = () => ({
  appId: "fixture.review",
  versionId: randomUUID(),
  versionNo: 1,
  manifest,
  sha256,
  artifactUrl: `https://artifacts.example/artifacts/${sha256}.html`,
});
test("real reviewer queue, isolated preview and recorded approve/reject decisions", async ({
  page,
  request,
}, info) => {
  test.skip(!process.env.E2E_DATABASE_URL, "Requires disposable PostgreSQL");
  const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  const reviewer = (
    await db.query<{ id: string }>(
      "SELECT identity.resolve_telegram(102) AS id",
    )
  ).rows[0]?.id;
  if (!reviewer) throw new Error("Reviewer fixture missing");
  const appId = `fixture.review.${info.project.name}.${String(Date.now())}`;
  const api = "http://127.0.0.1:8000";
  const reviewerHeaders = { Authorization: `tma ${signed()}` };
  const authorHeaders = { Authorization: `tma ${signed(101)}` };
  try {
    await db.query(
      "INSERT INTO identity.role_grants(subject_id,role_name) VALUES ($1,'apps.reviewer') ON CONFLICT DO NOTHING",
      [reviewer],
    );
    const first = await request.post(`${api}/apps/${appId}/versions`, {
      headers: authorHeaders,
      data: { manifest, sha256 },
    });
    expect(first.status()).toBe(201);
    const submitted = (await first.json()) as { versionId: string };
    const denied = await request.get(`${api}/apps/review-queue`, {
      headers: authorHeaders,
    });
    expect(denied.status()).toBe(403);
    expect(
      (
        await request.post(
          `${api}/apps/${appId}/versions/${submitted.versionId}/approve`,
          { headers: authorHeaders, data: { reason: "Unauthorized fixture" } },
        )
      ).status(),
    ).toBe(403);
    await page.route("https://artifacts.example/**", (route) => {
      expect(route.request().headers().authorization).toBeUndefined();
      return route.fulfill({
        contentType: "text/html",
        headers: { "access-control-allow-origin": "*" },
        body: artifact,
      });
    });
    let consentCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/consents")) consentCalls++;
    });
    expect(
      (
        await request.get(`${api}/apps/review-queue`, {
          headers: { Authorization: `tma ${signed(102, 3601)}` },
        })
      ).status(),
    ).toBe(401);
    await launch(page);
    const row = page.locator(".review-row").filter({ hasText: appId });
    await expect(row).toBeVisible();
    await expect(
      row.getByText("Official (requested)", { exact: false }),
    ).toBeVisible();
    await row.getByRole("button", { name: "Preview app" }).click();
    const frame = page.frameLocator(`iframe[title="${manifest.name}"]`);
    for (const field of ["identity", "consent", "money", "signature"])
      await expect(frame.locator("body")).toHaveAttribute(
        `data-${field}`,
        "capability_denied",
      );
    await expect(page.locator("iframe")).toHaveAttribute(
      "sandbox",
      "allow-scripts",
    );
    expect(consentCalls).toBe(0);
    expect(
      await page
        .locator(".screen")
        .evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    const actionsClearFooter = () =>
      row.locator(".review-actions").evaluate((actions) => {
        const footer = document.querySelector(".screen > nav");
        if (!footer) throw new Error("Footer missing");
        return (
          footer.getBoundingClientRect().top >=
          actions.getBoundingClientRect().bottom
        );
      });
    expect(await actionsClearFooter()).toBe(true);
    await row
      .getByLabel("Decision reason")
      .fill("Reviewed in isolated sandbox");
    await row.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    const second = await request.post(`${api}/apps/${appId}/versions`, {
      headers: authorHeaders,
      data: { manifest, sha256 },
    });
    expect(second.status()).toBe(201);
    const next = (await second.json()) as { versionId: string };
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page.getByRole("button", { name: "App review", exact: true }).click();
    await row
      .getByLabel("Decision reason")
      .fill("Requested capabilities need revision");
    expect(await actionsClearFooter()).toBe(true);
    await row.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(row).toHaveCount(0);
    const records = await db.query(
      "SELECT status,review_reason,approved_by FROM apps.versions WHERE app_id=$1 ORDER BY version_no",
      [appId],
    );
    expect(records.rows).toEqual([
      {
        status: "approved",
        review_reason: "Reviewed in isolated sandbox",
        approved_by: reviewer,
      },
      {
        status: "rejected",
        review_reason: "Requested capabilities need revision",
        approved_by: reviewer,
      },
    ]);
    expect(
      (
        await request.post(
          `${api}/apps/${appId}/versions/${next.versionId}/approve`,
          { headers: reviewerHeaders, data: { reason: "stale" } },
        )
      ).status(),
    ).toBe(409);
  } finally {
    await db.query(
      "DELETE FROM identity.role_grants WHERE subject_id=$1 AND role_name='apps.reviewer'",
      [reviewer],
    );
    await db.end();
  }
});
test("denied, expired, unavailable and empty queues recover with translated copy", async ({
  page,
}) => {
  let status = 403;
  let probes = 0;
  let versions: unknown[] = [];
  await page.route("**/apps/review-queue", (route) =>
    route.fulfill({
      status: probes++ === 0 ? 200 : status,
      contentType: "application/json",
      body: JSON.stringify(
        probes === 1 || status === 200 ? { versions } : { error: "fixture" },
      ),
    }),
  );
  await launch(page);
  await expect(page.getByText("Reviewer access is required.")).toBeVisible();
  status = 401;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Reopen RADA from Telegram, then try again."),
  ).toBeVisible();
  status = 503;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("Check your connection and try again."),
  ).toBeVisible();
  status = 200;
  versions = [{ ...version(), sha256: "invalid" }];
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".review-row")).toHaveCount(0);
  versions = [];
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Queue is clear")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox").selectOption("uk");
  await page
    .getByRole("button", { name: t("uk", "common.close"), exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: t("uk", "review.title") }),
  ).toBeVisible();
  await expect(page.getByText(t("uk", "review.empty"))).toBeVisible();
});
test("preview integrity failure and stale decisions fail closed", async ({
  page,
}) => {
  const row = version();
  await page.route("**/apps/review-queue", (route) =>
    route.fulfill({ json: { versions: [row] } }),
  );
  await page.route("https://artifacts.example/**", (route) =>
    route.fulfill({
      headers: { "access-control-allow-origin": "*" },
      body: "wrong bytes",
    }),
  );
  await page.route("**/versions/*/approve", (route) =>
    route.fulfill({ status: 409, json: { error: "invalid_transition" } }),
  );
  await launch(page);
  await page.getByRole("button", { name: "Preview app" }).click();
  await expect(
    page.getByText("Preview could not be verified or loaded."),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await page.getByLabel("Decision reason").fill("Reviewed fixture");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByText(
      "This version has changed. Refresh the queue before deciding.",
    ),
  ).toBeVisible();
});
test("late queue response cannot replace a destination after Back", async ({
  page,
}) => {
  let finish: (() => void) | undefined;
  let probes = 0;
  await page.route("**/apps/review-queue", async (route) => {
    if (probes++ === 0) {
      await route.fulfill({ json: { versions: [] } });
      return;
    }
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    await route.fulfill({ json: { versions: [version()] } }).catch(() => {});
  });
  await launch(page);
  await expect(page.getByText("Loading…", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  finish?.();
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".review-row")).toHaveCount(0);
});

test("non-reviewer profile has no admin entry", async ({ page, request }) => {
  test.skip(!process.env.E2E_DATABASE_URL, "Requires disposable PostgreSQL");
  await launch(page, signed(101), false);
  await expect(
    page.getByText("Private profile", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await request.get("http://127.0.0.1:8000/apps/review-queue", {
        headers: { Authorization: `tma ${signed(101)}` },
      })
    ).status(),
  ).toBe(403);
  await expect(
    page.getByRole("button", { name: "App review", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(t("en", "review.accessUnavailable"))).toHaveCount(
    0,
  );
  await page.route("**/apps/review-queue", (route) =>
    route.fulfill({ status: 404, json: { error: "not_found" } }),
  );
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  const unavailableProbe = page.waitForResponse(
    (response) =>
      response.url().endsWith("/apps/review-queue") &&
      response.status() === 404,
  );
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await unavailableProbe;
  await expect(page.getByText(t("en", "review.accessUnavailable"))).toHaveCount(
    0,
  );
  await page.unroute("**/apps/review-queue");
  await page.route("**/apps/review-queue", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } }),
  );
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Profile", exact: true }).click();
  await expect(
    page.getByText(t("en", "review.accessUnavailable")),
  ).toBeVisible();
});
