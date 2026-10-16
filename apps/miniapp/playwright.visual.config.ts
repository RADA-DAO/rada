import { defineConfig } from "@playwright/test";

/** Screenshot tests of the component catalog. Baselines are Linux renders; see packages/ui/README.md. */
export default defineConfig({
  testDir: "./visual",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  expect: {
    toHaveScreenshot: { animations: "disabled", maxDiffPixelRatio: 0 },
  },
  use: {
    baseURL: "http://127.0.0.1:4174",
    colorScheme: "light",
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    deviceScaleFactor: 1,
  },
  projects: [
    ...["chromium", "webkit"].flatMap((browserName) => [
      {
        name: `${browserName}-mobile`,
        use: {
          browserName: browserName as "chromium" | "webkit",
          viewport: { width: 390, height: 844 },
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
      "CATALOG=true npx vite build --config apps/miniapp/vite.config.ts && CATALOG=true npx vite preview --config apps/miniapp/vite.config.ts --port 4174",
    url: "http://127.0.0.1:4174/catalog.html",
    reuseExistingServer: !process.env.CI,
  },
});
