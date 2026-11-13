import { defineConfig } from "@playwright/test";

const origin = process.env.RADA_LOCAL_WEB_ORIGIN;
if (!origin || !/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error(
    "Run UI/SDK verification through the disposable local launcher",
  );

export default defineConfig({
  testDir: "../apps/miniapp/tests",
  testMatch: "ui-sdk.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "../test-results/ui-sdk",
  use: { baseURL: origin, ignoreHTTPSErrors: true, trace: "retain-on-failure" },
  projects: [
    {
      name: "chromium-phone-320",
      use: {
        browserName: "chromium",
        viewport: { width: 320, height: 740 },
        hasTouch: true,
      },
    },
    {
      name: "webkit-phone-390",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      },
    },
    {
      name: "chromium-phone-430",
      use: {
        browserName: "chromium",
        viewport: { width: 430, height: 932 },
        hasTouch: true,
      },
    },
    {
      name: "webkit-tablet-portrait",
      use: {
        browserName: "webkit",
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },
    {
      name: "chromium-tablet-landscape",
      use: {
        browserName: "chromium",
        viewport: { width: 1024, height: 768 },
        hasTouch: true,
      },
    },
    {
      name: "chromium-desktop-1280",
      use: { browserName: "chromium", viewport: { width: 1280, height: 900 } },
    },
    {
      name: "webkit-desktop-1440",
      use: { browserName: "webkit", viewport: { width: 1440, height: 900 } },
    },
  ],
});
