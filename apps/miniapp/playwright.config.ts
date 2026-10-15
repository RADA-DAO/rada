import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
  projects: [
    ...["chromium", "webkit"].flatMap((browserName) => [
      {
        name: `${browserName}-mobile`,
        use: {
          browserName: browserName as "chromium" | "webkit",
          viewport: { width: 390, height: 844 },
          hasTouch: true,
        },
      },
      {
        name: `${browserName}-desktop`,
        use: {
          browserName: browserName as "chromium" | "webkit",
          viewport: { width: 1280, height: 900 },
        },
      },
    ]),
  ],
  webServer: {
    cwd: new URL("../..", import.meta.url).pathname,
    command:
      "E2E_TONCONNECT_MOCK=true npm run build:miniapp && npx vite preview --config apps/miniapp/vite.config.ts",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
