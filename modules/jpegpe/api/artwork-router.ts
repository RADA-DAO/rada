import { createHash } from "node:crypto";
import type { Hono } from "hono";
import { artworkPath, type ArtworkStore } from "./artwork-store.ts";
import { validArtwork } from "./artwork-validation.ts";

type Authenticated = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;
export const frogUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerArtworkRoutes(
  app: Hono,
  store: ArtworkStore,
  authenticated: Authenticated,
  staging = false,
) {
  let start = 0,
    count = 0,
    active = 0;
  // Shared process budget, including misses; do not trust client IP headers.
  app.on(
    ["GET", "HEAD"],
    ["/v1/frogs/:frogId/artwork", "/v1/frogs/:frogId/artwork/:sha256"],
    async (c) => {
      c.header("Cache-Control", "no-store");
      if (Date.now() - start >= 60_000) {
        start = Date.now();
        count = 0;
      }
      if (++count > 200 || active >= 4) {
        c.header("Retry-After", "60");
        return c.json({ error: "rate_limited" }, 429);
      }
      const id = c.req.param("frogId")!;
      const hash = c.req.param("sha256");
      if (
        !frogUuid.test(id) ||
        (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))
      )
        return c.json({ error: "not_found" }, 404);
      active++;
      try {
        const image = await store.image(id, await authenticated(c, false));
        if (
          !image ||
          !validArtwork(image) ||
          createHash("sha256").update(image.bytes).digest("hex") !==
            image.sha256 ||
          (hash !== undefined && hash !== image.sha256)
        )
          return c.json({ error: "not_found" }, 404);
        c.header("X-Content-Type-Options", "nosniff");
        c.header("Content-Security-Policy", "default-src 'none'");
        // The shell may be hosted on a different site; CORS still uses the app allowlist.
        c.header("Cross-Origin-Resource-Policy", "cross-origin");
        c.header("Vary", "Origin, Authorization");
        c.header("Content-Type", image.contentType);
        c.header("Content-Location", artworkPath(id, image.sha256));
        const cacheable = image.isPublic && !staging && hash !== undefined;
        if (cacheable)
          c.header("Cache-Control", "public, max-age=31536000, immutable");
        const etag = `"${image.sha256}"`;
        c.header("ETag", etag);
        // Authorization and validation always precede conditional responses.
        if (
          c.req
            .header("If-None-Match")
            ?.split(",")
            .some((v) => [etag, `W/${etag}`, "*"].includes(v.trim()))
        )
          return c.body(null, 304);
        c.header("Content-Length", String(image.bytes.length));
        return c.req.method === "HEAD"
          ? c.body(null, 200)
          : c.body(new Uint8Array(image.bytes), 200);
      } finally {
        active--;
      }
    },
  );
}
