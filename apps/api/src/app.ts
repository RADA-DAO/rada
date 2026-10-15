import { Hono } from "hono";
import { cors } from "hono/cors";
import { verifyTelegramInitData } from "./auth.ts";
import type { IdentityStore } from "./database.ts";
import {
  unavailableMembership,
  type MembershipProvider,
  type MembershipStatus,
} from "./membership.ts";

export function createApp(
  token: string,
  store: IdentityStore,
  allowedOrigins: string[] = [],
  membership: MembershipProvider = unavailableMembership,
) {
  if (!token) throw new Error("Canonical bot token required");
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    cors({
      origin: (origin) =>
        allowedOrigins.includes(origin) ? origin : undefined,
      allowMethods: ["GET"],
      allowHeaders: ["Authorization"],
      credentials: false,
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/me", async (c) => {
    const authorization = c.req.header("Authorization") ?? "";
    if (!authorization.startsWith("tma "))
      return c.json({ error: "unauthorized" }, 401);
    const telegramId = await verifyTelegramInitData(
      authorization.slice(4),
      token,
    );
    if (!telegramId) return c.json({ error: "unauthorized" }, 401);
    const own = await store.me(telegramId);
    let status: MembershipStatus = "unavailable";
    try {
      status = await membership.status(telegramId);
    } catch {
      /* Preserve own identity during provider failure. */
    }
    return c.json({ ...own, membership: { status } });
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  // Never log credentials, raw initData, database errors or Telegram profile data.
  app.onError(
    () =>
      new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      }),
  );
  return app;
}
