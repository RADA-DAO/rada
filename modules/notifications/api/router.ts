import type { Hono } from "hono";
import type { NotificationStore, Preference } from "./store.ts";
import { readBoundedJson } from "../../../packages/http/body.ts";
type Auth = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;
export function validPreference(value: unknown): value is Preference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Preference;
  const hour = (v: unknown) =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 23;
  return (
    Object.keys(p).sort().join(",") ===
      "category,enabled,locale,quiet_end,quiet_start" &&
    ["splash", "governance"].includes(p.category) &&
    typeof p.enabled === "boolean" &&
    ["en", "uk"].includes(p.locale) &&
    ((p.quiet_start === null && p.quiet_end === null) ||
      (hour(p.quiet_start) &&
        hour(p.quiet_end) &&
        p.quiet_start !== p.quiet_end))
  );
}
export function registerNotificationRoutes(
  app: Hono,
  store: NotificationStore,
  auth: Auth,
) {
  app.get("/v1/notifications/preferences", async (c) => {
    const actor = await auth(c, false);
    if (!actor) return c.json({ error: "unauthorized" }, 401);
    return c.json({ preferences: await store.read(actor) });
  });
  for (const action of ["preferences", "test"] as const)
    app.post(`/v1/notifications/${action}`, async (c) => {
      const actor = await auth(c, true);
      if (!actor) return c.json({ error: "unauthorized" }, 401);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "unsupported_type" }, 415);
      let input: unknown;
      try {
        input = await readBoundedJson(c.req.raw, 1024);
      } catch {
        return c.json({ error: "invalid_body" }, 400);
      }
      if (action === "preferences") {
        if (!validPreference(input))
          return c.json({ error: "invalid_body" }, 400);
        await store.save(actor, input);
        return c.json({ preferences: await store.read(actor) });
      }
      const value = input as { category?: unknown } | null;
      if (
        !value ||
        Object.keys(value).length !== 1 ||
        !["splash", "governance"].includes(String(value.category))
      )
        return c.json({ error: "invalid_body" }, 400);
      if (!(await store.test(actor, String(value.category)))) {
        c.header("Retry-After", "60");
        return c.json({ error: "consent_or_rate_limit" }, 429);
      }
      return c.json({ queued: true }, 202);
    });
}
