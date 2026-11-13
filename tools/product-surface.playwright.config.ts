import { defineConfig } from "@playwright/test";

/** The release surface is built separately from the internal SDK rehearsal. */
export default defineConfig({
  testDir: "../apps/miniapp/tests",
  testMatch: "product-surface.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  outputDir: "../test-results/product-surface",
  use: {
    baseURL: "http://127.0.0.1:4188",
    trace: "retain-on-failure",
  },
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
  webServer: {
    cwd: new URL("..", import.meta.url).pathname,
    command:
      "npm run build:miniapp -- --outDir dist-product-surface && npx vite preview --config apps/miniapp/vite.config.ts --outDir dist-product-surface --port 4188 --strictPort",
    env: {
      CI: "true",
      RADA_DEVELOPER_SURFACE: "false",
      VITE_TELEGRAM_APP_LINK: "https://t.me/rada_fixture_bot/app",
      E2E_TONCONNECT_MOCK: "true",
    },
    url: "http://127.0.0.1:4188",
    reuseExistingServer: false,
  },
});
