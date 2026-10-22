import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
/** Build version reported with client errors: RADA_BUILD, else git short sha, else "dev". */
function buildVersion(): string {
  const configured = process.env.RADA_BUILD?.trim();
  if (configured && /^[0-9A-Za-z._-]{1,32}$/.test(configured))
    return configured;
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "dev";
  }
}
/** Component catalog build for visual tests; production builds never include it. */
const catalog = process.env.CATALOG === "true";

export default defineConfig({
  root: "apps/miniapp",
  define: { __RADA_BUILD__: JSON.stringify(buildVersion()) },
  build: {
    assetsInlineLimit: (path) => (path.endsWith(".woff2") ? false : undefined),
    ...(catalog
      ? {
          outDir: "dist-catalog",
          emptyOutDir: true,
          rollupOptions: { input: "apps/miniapp/catalog.html" },
        }
      : {}),
  },
  resolve: {
    alias: [
      {
        find: /^@rada\/ui\/design-system\.css$/,
        replacement: new URL(
          "../../packages/ui/src/design-system.css",
          import.meta.url,
        ).pathname,
      },
      {
        find: /^@rada\/ui\/screens\/([a-z0-9-]+\.css)$/,
        replacement: `${new URL("../../packages/ui/src/screens/", import.meta.url).pathname}$1`,
      },
      {
        find: /^@rada\/ui$/,
        replacement: new URL("../../packages/ui/src/index.ts", import.meta.url)
          .pathname,
      },
      ...(process.env.E2E_TONCONNECT_MOCK === "true"
        ? [
            {
              find: "@tonconnect/ui",
              replacement: new URL(
                "./tests/fixtures/tonconnect-ui.ts",
                import.meta.url,
              ).pathname,
            },
          ]
        : []),
    ],
  },
  plugins: [
    {
      name: "secondary-screen-retries",
      generateBundle(_, bundle) {
        const sources = {
          "launcher-editor": "/apps/miniapp/src/desktop-screens.ts",
          review: "/apps/miniapp/src/review.ts",
          "community-app": "/apps/miniapp/src/community-app.ts",
          treasury: "/apps/miniapp/src/desktop-screens.ts",
          governance: "/apps/miniapp/src/desktop-screens.ts",
          profile: "/apps/miniapp/src/profile-panel.ts",
          collection: "/apps/miniapp/src/collection.ts",
          holders: "/apps/miniapp/src/holders.ts",
          splash: "/apps/miniapp/src/desktop-screens.ts",
        };
        const files = Object.fromEntries(
          Object.entries(sources).flatMap(([name, source]) => {
            const chunk = Object.values(bundle).find(
              (item) =>
                item.type === "chunk" && item.facadeModuleId?.endsWith(source),
            );
            return chunk ? [[name, chunk.fileName]] : [];
          }),
        );
        if (Object.keys(files).length)
          this.emitFile({
            type: "asset",
            fileName: "screen-chunks.json",
            source: JSON.stringify(files),
          });
      },
    },
    {
      name: "wallet-manifest",
      generateBundle() {
        const configured = process.env.VITE_TON_CONNECT_APP_ORIGIN;
        if (!configured) return;
        const origin = new URL(configured);
        if (
          origin.origin !== configured ||
          origin.protocol !== "https:" ||
          origin.username ||
          origin.password ||
          ["localhost", "127.0.0.1"].includes(origin.hostname) ||
          origin.hostname.endsWith(".localhost") ||
          origin.hostname.startsWith("[") ||
          /^\d+(?:\.\d+){3}$/.test(origin.hostname)
        )
          throw new Error("Invalid VITE_TON_CONNECT_APP_ORIGIN");
        this.emitFile({
          type: "asset",
          fileName: "tonconnect-manifest.json",
          source: JSON.stringify({
            url: configured,
            name: "RADA",
            iconUrl: `${configured}/wallet-icon.png`,
          }),
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
