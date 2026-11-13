import { test, expect } from "@playwright/test";
import { runExampleLifecycle } from "../../../packages/platform-sdk/scripts/example-lifecycle.ts";

test("SDK example: real API publication, host integrity, update, rollback and withdrawal", async ({
  page,
}, info) => {
  const apiOrigin = process.env.RADA_LOCAL_API_ORIGIN;
  const artifactsDirectory = process.env.RADA_LOCAL_ARTIFACT_DIR;
  test.skip(
    !apiOrigin || !artifactsDirectory,
    "Disposable local platform required",
  );
  if (!apiOrigin || !artifactsDirectory) return;
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  const result = await runExampleLifecycle({
    apiOrigin,
    artifactsDirectory,
    appId: `example.hello.${info.project.name}.${String(Date.now())}`,
    inspectRelease: async ({ stage, release }) => {
      const catalog = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/apps/published"),
      );
      await page.goto("/");
      expect((await catalog).status()).toBe(200);
      const tile = page.getByRole("button", {
        name: /^Hello community/,
      });
      if (!release) {
        await expect(
          page.getByText("No other apps yet", { exact: true }),
        ).toBeVisible();
        await expect(tile).toHaveCount(0);
        return;
      }
      await tile.click();
      const frame = page.frameLocator("iframe[sandbox='allow-scripts']");
      await expect(frame.locator("body")).toHaveAttribute("data-ready", "true");
      await expect(frame.locator("body")).toHaveAttribute(
        "data-revision",
        stage === "updated" ? "2" : "1",
      );
      await expect(
        frame.getByRole("heading", { name: "Hello, community" }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Add one", exact: true }).click();
      await expect(frame.locator("#count")).toHaveText("Local count: 1");
      expect(
        await frame.locator("body").evaluate(() => {
          let parentReadable = false;
          try {
            parentReadable = Boolean(parent.document);
          } catch {
            /* opaque origin */
          }
          return {
            origin: location.origin,
            telegram: "Telegram" in window,
            parentReadable,
            bridge: Object.keys(
              (window as unknown as { rada: { member: object } }).rada.member,
            ).sort(),
          };
        }),
      ).toEqual({
        origin: "null",
        telegram: false,
        parentReadable: false,
        bridge: ["back", "request"],
      });
      await page.screenshot({
        path: info.outputPath(`sdk-example-${stage}.png`),
      });
      await frame
        .getByRole("button", { name: "Back to apps", exact: true })
        .click();
      await expect(page.locator("iframe[sandbox='allow-scripts']")).toHaveCount(
        0,
      );
      if (stage === "updated") {
        // Deliberately corrupt only this response; positive stages use the real artifact server.
        await page.route(release.artifactUrl, (route) =>
          route.fulfill({
            body: "corrupt artifact",
            contentType: "text/html",
            headers: { "Access-Control-Allow-Origin": "*" },
          }),
        );
        await page.goto("/");
        await tile.click();
        await expect(
          page.locator("iframe[sandbox='allow-scripts']"),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Try again", exact: true }),
        ).toBeVisible();
        await page.unroute(release.artifactUrl);
      }
    },
  });
  expect(result.status).toBe("withdrawn");
  expect(failures).toEqual([]);
});
