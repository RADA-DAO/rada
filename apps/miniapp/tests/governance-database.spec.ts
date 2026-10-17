import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { Hono } from "hono";
import {
  PostgresGovernanceStore,
  registerGovernanceRoutes,
} from "../../../modules/governance/index.ts";
import { governanceFixture } from "./governance-fixture.ts";

// Only the identity/membership boundary uses synthetic actors. Router, restricted
// service connection, immutable vote versions, decisions and projections are real.
const databaseUrl = process.env.E2E_DATABASE_URL;
test.skip(
  !databaseUrl,
  "Requires the disposable Postgres database from npm run e2e",
);
let admin: pg.Pool;
let service: pg.Pool;
let member: string;
let steward: string;
let outsider: string;
test.beforeAll(async () => {
  if (!databaseUrl) return;
  const url = new URL(databaseUrl);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(["/rada_test", "/rada_governance_test"]).toContain(url.pathname);
  admin = new pg.Pool({ connectionString: databaseUrl });
  await admin.query(
    "CREATE ROLE governance_browser_fixture LOGIN PASSWORD 'browser-fixture-only' INHERIT; GRANT governance_service TO governance_browser_fixture",
  );
  url.username = "governance_browser_fixture";
  url.password = "browser-fixture-only";
  service = new pg.Pool({ connectionString: url.toString() });
  [member, steward, outsider] = [randomUUID(), randomUUID(), randomUUID()];
  await admin.query(
    "INSERT INTO identity.subjects(subject_id) VALUES($1),($2),($3)",
    [member, steward, outsider],
  );
  await admin.query(
    "INSERT INTO identity.role_grants(subject_id,role_name) VALUES($1,'governance.steward')",
    [steward],
  );
});
test.afterAll(async () => {
  if (!databaseUrl) return;
  await service.end();
  await admin.query("DROP ROLE governance_browser_fixture");
  await admin.end();
});
async function backend(page: Page, actor: string, closed = false) {
  const proposalId = randomUUID();
  const title = `Database proposal ${proposalId.slice(0, 8)}`;
  await admin.query(
    "INSERT INTO governance.proposals(proposal_id,author,title,body) VALUES($1,$2,$3,'Database-backed advisory proposal')",
    [proposalId, member, title],
  );
  await admin.query(
    `INSERT INTO governance.openings SELECT $1,$2,clock_timestamp()-interval '2 hours',
    clock_timestamp() + CASE WHEN $3 THEN interval '-1 hour' ELSE interval '1 hour' END,
    version,'{}',clock_timestamp() FROM governance.settings ORDER BY version DESC LIMIT 1`,
    [proposalId, steward, closed],
  );
  const store = new PostgresGovernanceStore(
    admin,
    service,
    {
      status: () =>
        Promise.resolve(actor === outsider ? "not_member" : "member"),
    },
    () =>
      Promise.resolve({
        resolveTelegramSubject: () => Promise.resolve(actor),
        governanceMembershipSnapshot: () =>
          Promise.resolve({
            members: [member, steward],
            checkedAt: new Date().toISOString(),
          }),
      }),
  );
  if (closed) await store.closeDue();
  const app = new Hono();
  // Staging protects public reads too: signed launches must carry the credential.
  app.use("*", async (c, next) => {
    if (!c.req.header("authorization"))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  registerGovernanceRoutes(app, store, (c) =>
    Promise.resolve(c.req.header("authorization") ? actor : null),
  );
  await governanceFixture(page, { member: actor !== outsider });
  await page.route("**/v1/governance/**", async (route) => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const response = await app.request(`${url.pathname}${url.search}`, {
      method: incoming.method(),
      headers: incoming.headers(),
      ...(incoming.postData() ? { body: incoming.postData() } : {}),
    });
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: await response.text(),
    });
  });
  await page.getByRole("button", { name: "DAO", exact: true }).click();
  if (closed)
    await page.getByRole("button", { name: "Closed", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
  return { proposalId, app };
}
test("member browser vote persists through the real API and reloads from Postgres", async ({
  page,
}) => {
  const { proposalId } = await backend(page, member);
  await page.getByRole("button", { name: "For", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "My vote", exact: true }),
  ).toBeVisible();
  const row = await admin.query<{ choice: string; receipt: string }>(
    "SELECT choice,receipt FROM governance.votes WHERE proposal_id=$1",
    [proposalId],
  );
  expect(row.rows[0]?.choice).toBe("for");
  await expect(
    page
      .getByText(`Receipt: ${String(row.rows[0]?.receipt)}`, { exact: true })
      .first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Against", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Against", exact: true }),
  ).toBeDisabled();
  const tally = await admin.query<{ tally: { against: number; for: number } }>(
    "SELECT governance.read_proposal($1)->'tally' AS tally",
    [proposalId],
  );
  expect(tally.rows[0]?.tally).toEqual({ for: 0, against: 1, abstain: 0 });
});
test("steward role and public decision persist through restricted API connection", async ({
  page,
}) => {
  const { proposalId } = await backend(page, steward, true);
  await page
    .getByRole("button", { name: "Record decision", exact: true })
    .click();
  await page.getByLabel("Decision", { exact: true }).selectOption("defer");
  await page
    .getByLabel("Public reason", { exact: true })
    .fill("Request a clearer execution plan.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByText("Request a clearer execution plan."),
  ).toBeVisible();
  const row = await admin.query<{ outcome: string; reason: string }>(
    "SELECT outcome,reason FROM governance.decisions WHERE proposal_id=$1",
    [proposalId],
  );
  expect(row.rows[0]).toEqual({
    outcome: "defer",
    reason: "Request a clearer execution plan.",
  });
});
test("non-member sees public data while the API independently rejects a vote", async ({
  page,
}) => {
  const { proposalId, app } = await backend(page, outsider);
  await expect(page.getByText(/Only verified current members/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "For", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Record decision", exact: true }),
  ).toHaveCount(0);
  const response = await app.request(
    `/v1/governance/proposals/${proposalId}/vote`,
    {
      method: "POST",
      headers: {
        authorization: "synthetic-outsider",
        "content-type": "application/json",
      },
      body: JSON.stringify({ choice: "for" }),
    },
  );
  expect(response.status).toBe(403);
  const count = await admin.query<{ count: string }>(
    "SELECT count(*) FROM governance.votes WHERE proposal_id=$1",
    [proposalId],
  );
  expect(count.rows[0]?.count).toBe("0");
});
