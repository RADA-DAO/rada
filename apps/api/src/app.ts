import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  verifyTelegramInitData,
  type IdentityStore,
  registerIdentityRoutes,
  unavailableMembership,
  type MembershipProvider,
} from "../../../modules/identity/index.ts";
import {
  type RegistryStore,
  registerRegistryRoutes,
} from "../../../modules/apps/index.ts";

export function createApp(
  token: string,
  store: IdentityStore,
  allowedOrigins: string[] = [],
  membership: MembershipProvider = unavailableMembership,
  syntheticOnly = false,
  registry?: RegistryStore,
  artifactOrigin?: string,
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
      allowMethods: ["GET", "PUT", "POST"],
      allowHeaders: ["Authorization", "Content-Type"],
      credentials: false,
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));
  async function authenticated(
    c: { req: { header(name: string): string | undefined } },
    privileged: boolean,
  ) {
    const authorization = c.req.header("Authorization") ?? "";
    if (!authorization.startsWith("tma ")) return null;
    const id = await verifyTelegramInitData(
      authorization.slice(4),
      token,
      privileged ? "privileged" : "ordinary",
    );
    return id && (!syntheticOnly || ["101", "102"].includes(id)) ? id : null;
  }
  if (registry && artifactOrigin)
    registerRegistryRoutes(app, registry, artifactOrigin, authenticated);
  registerIdentityRoutes(app, store, authenticated, membership, syntheticOnly);
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
