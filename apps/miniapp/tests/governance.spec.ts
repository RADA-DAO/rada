import { test, expect, type Page } from "@playwright/test";
import { governanceFixture, proposal, rules } from "./governance-fixture.ts";
const open = async (page: Page, tab?: string) => {
  const tile = page.getByRole("button", { name: "DAO", exact: true });
  await expect(tile).not.toHaveAttribute("aria-describedby");
  await tile.click();
  await expect(
    page.getByRole("button", { name: "Open", exact: true }),
  ).toBeVisible();
  if (tab) await page.getByRole("button", { name: tab, exact: true }).click();
  await page
    .getByRole("button", { name: "Community workshop", exact: true })
    .click();
  await expect(
    page.getByText("Run a public workshop and publish the recording."),
  ).toBeVisible();
};
const confirm = async (page: Page) => {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
};
test("member votes, changes and withdraws with receipts; Back closes sheets", async ({
  page,
}, info) => {
  const fixture = await governanceFixture(page, { member: true });
  await open(page);
  await expect(page.getByText(/Votes are advisory/)).toBeVisible();
  await page.screenshot({ path: info.outputPath("proposal.png") });
  await page.getByRole("button", { name: "For", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.writes).toHaveLength(0);
  await page.getByRole("button", { name: "For", exact: true }).click();
  await confirm(page);
  await expect(
    page.getByText("Receipt: receipt-1", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Against", exact: true }).click();
  await confirm(page);
  await page
    .getByRole("button", { name: "Withdraw vote", exact: true })
    .click();
  await confirm(page);
  await expect(page.getByText("Vote withdrawn", { exact: true })).toBeVisible();
  expect(fixture.writes.map((w) => w.body.choice)).toEqual([
    "for",
    "against",
    null,
  ]);
});
test("steward decision requires a public reason and accepts execution evidence", async ({
  page,
}) => {
  const p = {
    ...proposal(),
    state: "closed" as const,
    decision_status: "decision_pending",
  };
  const fixture = await governanceFixture(page, { steward: true, proposal: p });
  await open(page, "Closed");
  await expect(
    page.getByText("Decision pending", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Record decision", exact: true })
    .click();
  await page.getByLabel("Decision", { exact: true }).selectOption("accept");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(page.getByText("This field is required.")).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  await page
    .getByLabel("Public reason", { exact: true })
    .fill("The workshop serves the community.");
  await confirm(page);
  await expect(
    page.getByText("The workshop serves the community."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Attach execution evidence", exact: true })
    .click();
  await page
    .getByLabel("What was executed?", { exact: true })
    .fill("Recording published.");
  await page
    .getByLabel("HTTPS evidence link", { exact: true })
    .fill("https://example.com/recording");
  await confirm(page);
  await expect(
    page.getByRole("link", { name: "HTTPS evidence link" }),
  ).toHaveAttribute("href", "https://example.com/recording");
});
test("non-member can read tally, anonymous receipts and decision but has no write controls", async ({
  page,
}) => {
  await governanceFixture(page);
  await open(page);
  await expect(page.getByText(/Only verified current members/)).toBeVisible();
  await expect(page.getByText("Anonymous", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Receipt: private-receipt", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Public Frog", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "For", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Record decision", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open voting", exact: true }),
  ).toHaveCount(0);
});
test("member creates with validation and sees retry-after rate limit", async ({
  page,
}) => {
  const fixture = await governanceFixture(page, {
    member: true,
    rateLimit: true,
  });
  await page.getByRole("button", { name: "DAO", exact: true }).click();
  await page
    .getByRole("button", { name: "Create proposal", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  expect(fixture.writes).toHaveLength(0);
  await page.getByLabel("Title", { exact: true }).fill("A new workshop");
  await page
    .getByLabel("Proposal", { exact: true })
    .fill("Publish a workshop.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirm", exact: true })
    .click();
  await expect(
    page.getByText("Too many proposals or requests. Try again in 120 seconds."),
  ).toBeVisible();
});
test("settings expose current values and history; only steward may change", async ({
  page,
}) => {
  await governanceFixture(page, { steward: true });
  await page.getByRole("button", { name: "DAO", exact: true }).click();
  await page
    .getByRole("button", { name: "Voting settings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Voting duration (hours, 1–720)",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Version 1 · 48", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Change settings", exact: true })
    .click();
  await expect(
    page.getByLabel("Voting duration (hours, 1–720)", { exact: true }),
  ).toHaveValue(String(rules.duration_hours));
  await page.keyboard.press("Escape");
});

test("frozen rules lock a second vote while live tally keeps refreshing", async ({
  page,
}) => {
  await page.clock.install();
  const p = { ...proposal(), rules: { ...rules, allow_vote_changes: false } };
  await governanceFixture(page, { member: true, proposal: p });
  await open(page);
  await page.getByRole("button", { name: "For", exact: true }).click();
  await confirm(page);
  await expect(
    page.getByText(
      "Vote changes and withdrawals are disabled for this opening.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Against", exact: true }),
  ).toHaveCount(0);
  p.tally.against = 7;
  await page.clock.fastForward(15000);
  await expect(
    page.getByRole("progressbar", { name: "Against", exact: true }),
  ).toHaveAttribute("aria-valuetext", "7");
});
