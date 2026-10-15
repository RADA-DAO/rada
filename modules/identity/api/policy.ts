import type { Hono } from "hono";
import { verifyTelegramInitData } from "./auth.ts";

export type IdentityAuthPolicy = {
  mode: "production" | "synthetic" | "allowlist";
  allows(id: string): boolean;
};

// Parse before creating pools/providers. Errors never include configured identities.
export function identityAuthPolicy(
  env: Record<string, string | undefined>,
): IdentityAuthPolicy {
  const runtime = env.STAGING_RUNTIME;
  const synthetic = env.STAGING_SYNTHETIC_ONLY;
  const mode = env.STAGING_AUTH_MODE;
  const ids = env.STAGING_ALLOWED_TELEGRAM_IDS;
  const invalid = () => {
    throw new Error("Invalid staging authentication configuration");
  };
  if (runtime !== undefined && runtime !== "true" && runtime !== "false")
    invalid();
  if (synthetic !== undefined && synthetic !== "true" && synthetic !== "false")
    invalid();
  if (runtime !== "true") {
    if (mode !== undefined || ids !== undefined || synthetic === "true")
      invalid();
    return { mode: "production", allows: () => true };
  }
  if (mode === "synthetic") {
    if (synthetic !== "true" || (ids !== undefined && ids !== "")) invalid();
    return { mode, allows: (id) => id === "101" || id === "102" };
  }
  if (mode !== "allowlist" || synthetic === "true" || !ids) return invalid();
  const values = ids.split(",").map((id) => id.trim());
  if (
    values.some(
      (id) => !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)),
    ) ||
    new Set(values).size !== values.length
  )
    invalid();
  const allowed = new Set(values);
  return { mode, allows: (id) => allowed.has(id) };
}

export function telegramAuthenticator(
  token: string,
  policy: IdentityAuthPolicy,
) {
  if (!token) throw new Error("Canonical bot token required");
  return async (
    c: { req: { header(name: string): string | undefined } },
    privileged: boolean,
  ): Promise<string | null> => {
    const authorization = c.req.header("Authorization") ?? "";
    if (!authorization.startsWith("tma ")) return null;
    const id = await verifyTelegramInitData(
      authorization.slice(4),
      token,
      privileged ? "privileged" : "ordinary",
    );
    return id && policy.allows(id) ? id : null;
  };
}

// Covers every staging API route, including otherwise public registry reads.
// CORS middleware handles OPTIONS first; liveness never touches persistence.
export function registerStagingGuard(
  app: Hono,
  authenticated: ReturnType<typeof telegramAuthenticator>,
  policy: IdentityAuthPolicy,
) {
  if (policy.mode === "production") return;
  app.use("*", async (c, next) => {
    if (
      c.req.method === "OPTIONS" ||
      (c.req.method === "GET" && c.req.path === "/health")
    )
      return next();
    if (!(await authenticated(c, false)))
      return c.json({ error: "unauthorized" }, 401);
    await next();
  });
}
