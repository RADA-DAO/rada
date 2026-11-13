import { createServer } from "node:https";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer as createViteServer } from "vite";
import {
  LOCAL_API,
  LOCAL_WEB,
  localLaunch,
  inlineScriptString,
} from "./local-platform-support.mjs";

/** Serve only immutable digest-named local HTML, never arbitrary paths.
 * @param {{directory:string, key:Buffer, cert:Buffer}} options
 */
export async function artifactServer(options) {
  const server = createServer(
    { key: options.key, cert: options.cert },
    (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Access-Control-Allow-Origin", LOCAL_WEB);
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "GET" && request.url === "/health") {
        response.setHeader("Content-Type", "application/json");
        response.end('{"status":"ok","runtime":"synthetic-local"}');
        return;
      }
      const hash = /^\/artifacts\/([0-9a-f]{64})\.html$/.exec(
        request.url ?? "",
      )?.[1];
      if (!hash || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(404).end();
        return;
      }
      void readFile(join(options.directory, "artifacts", `${hash}.html`))
        .then((bytes) => {
          if (createHash("sha256").update(bytes).digest("hex") !== hash) {
            response.writeHead(409).end();
            return;
          }
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(request.method === "HEAD" ? undefined : bytes);
        })
        .catch(() => response.writeHead(404).end());
    },
  );
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8443, "127.0.0.1", () => {
      resolve(undefined);
    });
  });
  return async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve(undefined);
      }),
    );
  };
}

/** Normal shell with a synthetic host only in this explicit local Vite process. */
export async function localWebServer() {
  const server = await createViteServer({
    configFile: "apps/miniapp/vite.config.ts",
    envDir: false,
    // This owned synthetic SDK runner rehearses the internal shell explicitly.
    // The fixture environment remains sanitized; this changes UI reachability only.
    define: { __RADA_DEVELOPER_SURFACE__: "true" },
    server: {
      host: "127.0.0.1",
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": {
          target: LOCAL_API,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
    plugins: [
      {
        name: "synthetic-local-host",
        transformIndexHtml(html) {
          const launch = inlineScriptString(localLaunch());
          const host = `<script>(()=>{const events=new Map(),backs=new Set();const app={initData:${launch},viewportHeight:innerHeight,safeAreaInset:{top:0,right:0,bottom:0,left:0},contentSafeAreaInset:{top:0,right:0,bottom:0,left:0},ready(){},expand(){},onEvent(name,handler){if(!events.has(name))events.set(name,new Set());events.get(name).add(handler)},offEvent(name,handler){events.get(name)?.delete(handler)},BackButton:{show(){},hide(){},onClick(handler){backs.add(handler)},offClick(handler){backs.delete(handler)}}};window.Telegram={WebApp:app};window.radaLocalHost=Object.freeze({emit(name,patch={}){Object.assign(app,patch);for(const handler of events.get(name)??[])handler()},back(){for(const handler of [...backs])handler()},listeners(){return [...events.values()].reduce((count,handlers)=>count+handlers.size,0)+backs.size}})})();</script>`;
          return html.replace(
            '<script src="https://telegram.org/js/telegram-web-app.js"></script>',
            host,
          );
        },
      },
    ],
  });
  await server.listen();
  return () => server.close();
}
