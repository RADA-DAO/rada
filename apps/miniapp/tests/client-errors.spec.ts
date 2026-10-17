import { test, expect } from "@playwright/test";
import pg from "pg";

test.beforeEach(async ({ page }) => {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
});

test("an uncaught error reaches the API once, sanitized", async ({
  page,
}, info) => {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  test.skip(
    !databaseUrl,
    "Runs through npm run e2e with a disposable database",
  );
  const marker = `ClientError${info.project.name.replace(/[^A-Za-z0-9]/g, "")}`;
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/client-errors"))
      bodies.push(request.postData() ?? "");
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Apps", exact: true }),
  ).toBeVisible();
  // Same error twice: one report. Personal-looking details must not survive.
  await page.evaluate((text) => {
    for (let i = 0; i < 2; i++)
      setTimeout(() => {
        const error = new TypeError(
          `${text} balance 98765 for a.b@example.com`,
        );
        error.name = text;
        throw error;
      });
  }, marker);
  const db = new pg.Pool({ connectionString: databaseUrl });
  try {
    await expect
      .poll(
        async () =>
          (
            await db.query<{ n: number }>(
              "SELECT count(*)::int AS n FROM ops.client_errors WHERE name = $1",
              [marker],
            )
          ).rows[0]?.n,
        { timeout: 10_000 },
      )
      .toBe(1);
    const row = (
      await db.query<{
        kind: string;
        name: string;
        route: string;
        build: string;
        frames: string[];
      }>(
        "SELECT kind, name, route, build, frames FROM ops.client_errors WHERE name = $1",
        [marker],
      )
    ).rows[0];
    if (!row) throw new Error("Missing report row");
    expect(row.kind).toBe("error");
    expect(row.name).toBe(marker);
    expect(row.route).toBe("launcher");
    expect(row.build).toMatch(/^[0-9A-Za-z._-]{1,32}$/);
    for (const frame of row.frames) expect(frame).toMatch(/^[\w.-]+:\d+:\d+$/);
    await db.query("DELETE FROM ops.client_errors WHERE name = $1", [marker]);
  } finally {
    await db.end();
  }
  for (const body of bodies) {
    expect((JSON.parse(body) as { message: string }).message).toBe("unknown");
    expect(body).not.toContain("98765");
    expect(body).not.toContain("example.com");
  }
});
