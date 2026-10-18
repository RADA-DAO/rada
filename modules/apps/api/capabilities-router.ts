import type { Hono } from "hono";
import { BodyTooLarge, readBoundedJson } from "../../../packages/http/body.ts";
import type { RegistryStore } from "./store.ts";

export function registerCapabilityRoutes(
  app: Hono,
  store: RegistryStore,
  authenticated: (
    c: { req: { header(name: string): string | undefined } },
    privileged: boolean,
  ) => Promise<string | null>,
) {
  app.post("/apps/:appId/capabilities/:operation", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const { appId, operation } = c.req.param();
    if (
      !/^[a-z][a-z0-9_.:-]{0,127}$/.test(appId) ||
      !/^(records\.(get|list|put|delete)|scores\.(submit|list|rank)|report)$/.test(
        operation,
      )
    )
      return c.json({ error: "invalid_request" }, 400);
    try {
      const body = await readBoundedJson(c.req.raw, 20000);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new SyntaxError();
      const b = body as Record<string, unknown>;
      if (
        Object.keys(b).length !== 2 ||
        typeof b.hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(b.hash) ||
        !b.payload ||
        typeof b.payload !== "object" ||
        Array.isArray(b.payload)
      )
        throw new SyntaxError();
      if (!store.capability) throw new Error("unavailable");
      return c.json(
        await store.capability(id, appId, b.hash, operation, b.payload),
      );
    } catch (error) {
      if (error instanceof BodyTooLarge)
        return c.json({ error: "limit_exceeded" }, 413);
      if (error instanceof SyntaxError)
        return c.json({ error: "invalid_request" }, 400);
      const code = (error as { code?: string }).code;
      if (code === "42501") return c.json({ error: "capability_denied" }, 403);
      if (code === "40001") return c.json({ error: "version_conflict" }, 409);
      if (code === "54000") return c.json({ error: "limit_exceeded" }, 413);
      if (code === "22023") return c.json({ error: "invalid_request" }, 400);
      if (code === "P0429") {
        c.header("Retry-After", operation === "report" ? "3600" : "60");
        return c.json({ error: "rate_limited" }, 429);
      }
      throw error;
    }
  });
  app.get("/apps/review-queue/reports", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    try {
      if (!store.reports) throw new Error("unavailable");
      return c.json({ reports: await store.reports(id) });
    } catch (error) {
      if ((error as { code?: string }).code === "42501")
        return c.json({ error: "forbidden" }, 403);
      throw error;
    }
  });
}
