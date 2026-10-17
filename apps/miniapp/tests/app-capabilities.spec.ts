import { test, expect } from "@playwright/test";
import { createHash, createHmac } from "node:crypto";
import pg from "pg";
function signed(id: number) {
  const data = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
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
  return `tma ${data}`;
}
test("sandbox records, scores and platform report reach the real services", async ({
  page,
  request,
}, info) => {
  test.skip(!process.env.E2E_DATABASE_URL, "Disposable PostgreSQL required");
  const db = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL });
  const appId = `fixture.capability.${info.project.name}.${String(Date.now())}`;
  const api = "http://127.0.0.1:8000";
  const author = { Authorization: signed(101) };
  const reviewer = { Authorization: signed(102) };
  const artifact = "<main>Capability fixture</main>";
  const hash = createHash("sha256").update(artifact).digest("hex");
  const manifest = {
    name: "Capability fixture",
    author: "Fixture",
    designRoute: "standard" as const,
    permissions: ["storage.self", "scores"] as const,
    minPlatformVersion: "1.0.0",
    boards: { points: { min: 0, max: 100 } },
  };
  try {
    await db.query(
      "INSERT INTO identity.role_grants(subject_id,role_name) VALUES(identity.resolve_telegram(102),'apps.reviewer') ON CONFLICT DO NOTHING",
    );
    await db.query(
      "DELETE FROM apps.capability_rates WHERE subject_id=identity.resolve_telegram(101) AND scope='reports'",
    );
    const submitted = await request.post(`${api}/apps/${appId}/versions`, {
      headers: author,
      data: { manifest, sha256: hash },
    });
    expect(submitted.status()).toBe(201);
    const version = (await submitted.json()) as { versionId: string };
    expect(
      (
        await request.post(
          `${api}/apps/${appId}/versions/${version.versionId}/approve`,
          { headers: reviewer, data: { reason: "Fixture review" } },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.post(
          `${api}/apps/${appId}/versions/${version.versionId}/publish`,
          { headers: reviewer, data: {} },
        )
      ).ok(),
    ).toBe(true);
    await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
      route.fulfill({ body: "" }),
    );
    await page.route(
      `https://artifacts.example/artifacts/${hash}.html`,
      (route) =>
        route.fulfill({
          body: artifact,
          contentType: "text/html",
          headers: { "Access-Control-Allow-Origin": "*" },
        }),
    );
    await page.addInitScript((token) => {
      Object.assign(window, {
        Telegram: {
          WebApp: {
            initData: token.slice(4),
            ready() {},
            expand() {},
            onEvent() {},
            offEvent() {},
            BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
          },
        },
      });
    }, author.Authorization);
    await page.goto("/");
    await page.getByRole("button", { name: /Capability fixture/ }).click();
    const frame = page.frameLocator("iframe[sandbox='allow-scripts']");
    await expect(frame.locator("main")).toHaveText("Capability fixture");
    const call = async (type: string, payload: unknown = {}) => {
      await frame.locator("body").evaluate(
        (body, args) => {
          delete (body as HTMLElement).dataset.result;
          const host = window as unknown as {
            rada: {
              member: {
                request(type: string, payload: unknown): Promise<unknown>;
              };
            };
          };
          void host.rada.member
            .request(args.type, args.payload)
            .then((value) => {
              (body as HTMLElement).dataset.result = JSON.stringify(value);
            })
            .catch((error: unknown) => {
              (body as HTMLElement).dataset.result =
                error instanceof Error ? error.message : "failed";
            });
        },
        { type: `rada.member.${type}`, payload },
      );
    };
    await call("records.list");
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      "capability_denied",
    );
    await call("permission.request", { permission: "storage.self" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Don't allow", exact: true })
      .click();
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      '{"granted":false}',
    );
    await call("permission.request", { permission: "storage.self" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      '{"granted":true}',
    );
    await call("records.put", { key: "save", value: { level: 3 }, version: 0 });
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      /"level":3/,
    );
    await call("records.put", { key: "save", value: 2, version: 0 });
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      "version_conflict",
    );
    await call("permission.request", { permission: "scores" });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      '{"granted":true}',
    );
    await call("scores.submit", { board: "points", score: 101 });
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      "invalid_request",
    );
    await call("scores.submit", { board: "points", score: 80 });
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      /"myRank":\{"rank":1,"score":80\}/,
    );
    await call("report", {
      text: "Child must not prefill this",
      appId: "forged",
      versionId: "forged",
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("What went wrong?")).toHaveValue("");
    await dialog.getByLabel("Category", { exact: true }).selectOption("bug");
    await dialog
      .getByLabel("What went wrong?")
      .fill("The fixture stopped responding.");
    await dialog.evaluate(async (node) => {
      await Promise.all(
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      );
    });
    await page.screenshot({ path: info.outputPath("report-sheet.png") });
    await dialog
      .getByRole("button", { name: "Send report", exact: true })
      .click();
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      '{"submitted":true}',
    );
    expect(
      (
        await request.get(`${api}/apps/review-queue/reports`, {
          headers: author,
        })
      ).status(),
    ).toBe(403);
    const queue = await request.get(`${api}/apps/review-queue/reports`, {
      headers: reviewer,
    });
    const reports = (
      (await queue.json()) as {
        reports: { appId: string; versionId: string; text: string }[];
      }
    ).reports;
    expect(reports.find((r) => r.appId === appId)).toMatchObject({
      versionId: version.versionId,
      text: "The fixture stopped responding.",
    });
    expect(
      (
        await request.put(`${api}/me/consents`, {
          headers: author,
          data: { appId, capability: "storage.self", granted: false },
        })
      ).ok(),
    ).toBe(true);
    await call("records.list");
    await expect(frame.locator("body")).toHaveAttribute(
      "data-result",
      "capability_denied",
    );
    const stored = await db.query<{ count: string }>(
      "SELECT count(*) FROM apps.records WHERE app_id=$1",
      [appId],
    );
    expect(stored.rows[0]?.count).toBe("0");
  } finally {
    await request.post(`${api}/apps/${appId}/withdraw`, {
      headers: reviewer,
      data: { reason: "Fixture cleanup" },
    });
    await db.query("DELETE FROM apps.problem_reports WHERE app_id=$1", [appId]);
    await db.query(
      "UPDATE identity.consents SET revoked_at=now() WHERE app_id=$1 AND revoked_at IS NULL",
      [appId],
    );
    await db.query(
      "DELETE FROM identity.role_grants WHERE subject_id=identity.resolve_telegram(102) AND role_name='apps.reviewer'",
    );
    await db.end();
  }
});
