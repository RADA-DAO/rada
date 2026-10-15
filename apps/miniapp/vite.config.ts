import { defineConfig } from "vite";
export default defineConfig({
  root: "apps/miniapp",
  plugins: [
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
