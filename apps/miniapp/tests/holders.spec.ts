import { test, expect, type Page } from "@playwright/test";

const frogId = "00000000-0000-4000-8000-000000000011";
const cursor = `JPEGPE:${"a".repeat(32)}:50`;
const entry = (rank: number, stale = false) => ({
  rank,
  frogId: rank === 1 ? frogId : "00000000-0000-4000-8000-000000000012",
  frogName: rank === 1 ? "first_frog" : "second_frog",
  amount: "1234567890123456789",
  asOf: new Date(Date.now() - (stale ? 7 : 1) * 3600000).toISOString(),
  stale,
});
async function launch(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.addInitScript(() => {
    const listeners = new Map<string, () => void>();
    Object.assign(window, {
      Telegram: {
        WebApp: {
          initData: "synthetic-ranking-fixture",
          ready() {},
          expand() {},
          onEvent() {},
          offEvent() {},
          BackButton: {
            show() {},
            hide() {},
            onClick: (cb: () => void) => listeners.set("back", cb),
            offClick() {},
          },
        },
      },
      fixtureBack: () => listeners.get("back")?.(),
    });
  });
  await page.route("**/me", (route) =>
    route.fulfill({
      json: {
        subject_id: "00000000-0000-4000-8000-000000000101",
        profile: {
          visibility: "public",
          public: {
            frog_id: frogId,
            username: "first_frog",
            background_color: null,
            accent_color: null,
          },
        },
        membership: { status: "unavailable" },
      },
    }),
  );
  await page.route("**/apps/published", (route) =>
    route.fulfill({ json: { apps: [] } }),
  );
  await page.goto("/");
  const tile = page.getByRole("button", { name: "Holders", exact: true });
  await expect(tile).toHaveAttribute("data-tier", "platform");
  await expect(tile).not.toHaveAttribute("aria-describedby");
  await expect(page.locator(".rada-identity-name")).toHaveText("first_frog");
  await tile.click();
}

test("holders list, viewer highlight, freshness, token switch and cursor pagination", async ({
  page,
}) => {
  const queries: URL[] = [];
  await page.route("**/v1/rankings/holders?*", (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const token = url.searchParams.get("token");
    const more = url.searchParams.has("cursor");
    return route.fulfill({
      json: {
        token,
        entries:
          token === "TON" ? [entry(2)] : more ? [entry(2, true)] : [entry(1)],
        nextCursor: token === "JPEGPE" && !more ? cursor : null,
      },
    });
  });
  await launch(page);
  const list = page.getByRole("list", { name: "Holders" });
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list.locator('[aria-current="true"]')).toContainText("You");
  await expect(list).toContainText("1,234,567,890.1235 JPEGPE");
  await expect(list).toContainText("As of");
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list).toContainText("Older than 6 h");
  expect(queries.at(-1)?.searchParams.get("cursor")).toBe(cursor);
  await page.getByRole("button", { name: "TON", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("TON");
  expect(queries.at(-1)?.searchParams.has("cursor")).toBe(false);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Holders", exact: true }),
  ).toBeVisible();
});

test("loading, empty, error and retry", async ({ page }) => {
  let respond: (() => void) | undefined;
  let calls = 0;
  await page.route("**/v1/rankings/holders?*", async (route) => {
    calls++;
    if (calls === 1)
      await new Promise<void>((resolve) => {
        respond = resolve;
      });
    await route.fulfill(
      calls === 2
        ? { status: 503, json: { error: "unavailable" } }
        : {
            json: {
              token: calls === 1 ? "JPEGPE" : "TON",
              entries: [],
              nextCursor: null,
            },
          },
    );
  });
  await launch(page);
  await expect(page.getByRole("status")).toBeVisible();
  await expect.poll(() => Boolean(respond)).toBe(true);
  respond?.();
  await expect(page.getByText("No holders yet.")).toBeVisible();
  await page.getByRole("button", { name: "TON", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load holders.",
  );
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByText("No holders yet.")).toBeVisible();
});
