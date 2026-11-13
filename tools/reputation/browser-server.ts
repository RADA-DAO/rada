import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createApp } from "../../apps/api/src/app.ts";
import type { createPostgresFixtureRuntime } from "./postgres-fixture.ts";

/** Real reputation routes/auth/SQL; synthetic identity profile, no Telegram calls. */
export async function browserServer(
  runtime: Awaited<ReturnType<typeof createPostgresFixtureRuntime>>,
) {
  const identity = {
    me: async (actor: string) => ({
      subject_id: await runtime.subject(actor),
      profile: { visibility: "private" as const, public: null },
      membership: { status: "unavailable" as const },
    }),
    ownFrogs: () => Promise.resolve([]),
    selectFrog: () => Promise.resolve(false),
    consents: () => Promise.resolve([]),
    setConsent: () => Promise.resolve(false),
  };
  const app = createApp(
    "synthetic-fixture-bot-token",
    identity,
    [],
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    runtime.store,
  );
  const root = resolve("apps/miniapp/dist");
  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".webp": "image/webp",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
  };
  const failures: string[] = [];
  const server = createServer((request, response) => {
    const abort = new AbortController();
    response.on("close", () => {
      abort.abort();
    });
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const chunks: Buffer[] = [];
        for await (const chunk of request)
          chunks.push(Buffer.from(chunk as Uint8Array));
        const data = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined)
            headers.set(key, Array.isArray(value) ? value.join(",") : value);
        }
        const result = await app.fetch(
          new Request(`http://127.0.0.1${url.pathname.slice(4)}${url.search}`, {
            method: request.method ?? "GET",
            headers,
            signal: abort.signal,
            ...(data.length ? { body: new Uint8Array(data).buffer } : {}),
          }),
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.flushHeaders();
        if (result.body) {
          const reader = result.body.getReader();
          const cancel = () => {
            void reader.cancel().catch(() => undefined);
          };
          abort.signal.addEventListener("abort", cancel, { once: true });
          try {
            while (!abort.signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (!response.write(chunk.value))
                await Promise.race([
                  once(response, "drain"),
                  once(response, "close"),
                ]);
            }
          } finally {
            abort.signal.removeEventListener("abort", cancel);
            await reader.cancel().catch(() => undefined);
          }
        }
      } else {
        const path = resolve(
          root,
          `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
        );
        if (!path.startsWith(root + sep)) throw new Error("invalid_path");
        response.setHeader(
          "Content-Type",
          mime[extname(path)] ?? "application/octet-stream",
        );
        response.setHeader("Cache-Control", "no-store");
        response.write(await readFile(path));
      }
      response.end();
    })().catch((error: unknown) => {
      if (!abort.signal.aborted)
        failures.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no_port");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    failures,
    async close() {
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}
