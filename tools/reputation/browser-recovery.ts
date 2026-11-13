import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
import type { ReputationStore } from "../../modules/reputation/index.ts";

/** Commit a real report, lose its HTTP response, then recover after a full reload. */
export async function reportReloadRecovery(
  page: Page,
  store: ReputationStore,
  tag: string,
) {
  const title = `Synthetic completed result ${tag}`;
  let settled: () => void = () => {};
  const delivered = new Promise<void>((resolve) => {
    settled = resolve;
  });
  let requestId: string | undefined;
  await page.route(
    "**/v1/reputation/reports",
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      const receipt = (await response.json()) as { requestId: string };
      requestId = receipt.requestId;
      await route.abort("failed");
      settled();
    },
    { times: 1 },
  );
  await page
    .getByRole("button", { name: "Report completed work", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("What did you complete?", { exact: true })
    .fill(title);
  await dialog
    .getByLabel("Describe the result", { exact: true })
    .fill("Completed a synthetic result without an attachment.");
  await dialog.getByRole("button", { name: "Submit", exact: true }).click();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      delivered,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("report_commit_timeout"));
        }, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.ok(requestId);
  await page.reload();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(
    page.getByText("Saved. Awaiting review.", { exact: true }),
  ).toBeVisible();
  const stored = await store.items("101", "today", null);
  assert.equal(stored.items.filter((item) => item.title === title).length, 1);
  assert.equal((await store.command("101", requestId))?.state, "checking");
  assert.equal((await store.summary("101", "today")).totalPoints, "0.25");
}
