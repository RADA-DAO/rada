import { defineConfig } from "@playwright/test";

const origin = process.env.RADA_LOCAL_WEB_ORIGIN;
if (!origin || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error("Run this suite through the disposable local launcher");

export default defineConfig({
  testDir: "../apps/miniapp/tests",
  testMatch: "sdk-example.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "../test-results/local-platform",
  use: { baseURL: origin, ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium-mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
    {
      name: "webkit-mobile",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
    {
      name: "chromium-desktop",
      use: { browserName: "chromium", viewport: { width: 1280, height: 900 } },
    },
  ],
});
