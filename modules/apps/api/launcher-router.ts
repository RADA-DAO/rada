import type { Hono } from "hono";
import { BodyTooLarge, readBoundedJson } from "../../../packages/http/body.ts";
import { validLayout } from "../../../packages/platform-sdk/src/launcher-layout.ts";
import type { RegistryStore } from "./store.ts";
export function registerLauncherRoutes(
  app: Hono,
  store: RegistryStore,
  authenticated: (
    c: { req: { header(name: string): string | undefined } },
    privileged: boolean,
  ) => Promise<string | null>,
) {
  for (const kind of ["layout", "activity"] as const) {
    app.on(["GET", "POST"], `/apps/launcher/${kind}`, async (c) => {
      c.header("Cache-Control", "private, no-store");
      const id = await authenticated(c, c.req.method === "POST");
      if (!id) return c.json({ error: "unauthorized" }, 401);
      try {
        if (
          c.req.method === "POST" &&
          !/^application\/json(?:\s*;|$)/i.test(
            c.req.header("Content-Type") ?? "",
          )
        )
          return c.json({ error: "invalid_request" }, 415);
        const body =
          c.req.method === "POST"
            ? await readBoundedJson(c.req.raw, 32768)
            : undefined;
        if (body !== undefined) {
          if (!body || typeof body !== "object" || Array.isArray(body))
            return c.json({ error: "invalid_request" }, 400);
          const b = body as Record<string, unknown>;
          if (
            kind === "layout"
              ? Object.keys(b).sort().join() !== "layout,version" ||
                !Number.isSafeInteger(b.version) ||
                Number(b.version) < 0 ||
                !validLayout(b.layout)
              : Object.keys(b).join() !== "appId" ||
                typeof b.appId !== "string" ||
                !/^[a-z][a-z0-9_.:-]{0,127}$/.test(b.appId)
          )
            return c.json({ error: "invalid_request" }, 400);
        }
        return c.json(await store.launcher!(id, kind, body));
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return c.json({ error: "invalid_request" }, 413);
        const code = (error as { code?: string }).code;
        if (code === "40001") return c.json({ error: "layout_conflict" }, 409);
        if (code === "42501") return c.json({ error: "forbidden" }, 403);
        if (code === "22023" || error instanceof SyntaxError)
          return c.json({ error: "invalid_request" }, 400);
        throw error;
      }
    });
  }
}
