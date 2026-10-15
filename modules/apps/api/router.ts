import type { Context, Hono } from "hono";
import { parseAppManifest } from "../../../packages/platform-sdk/src/app-manifest.ts";
import type { RegistryStore } from "./store.ts";

const slug = /^[a-z][a-z0-9_.:-]{0,127}$/;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/i;
function object(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
async function jsonBody(
  c: { req: { header(name: string): string | undefined; raw: Request } },
  limit = 16_384,
): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? ""))
    throw new Error("invalid_request");
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) {
        await reader.cancel();
        throw new Error("body_too_large");
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid_request");
  }
}

export function registerRegistryRoutes(
  app: Hono,
  store: RegistryStore,
  artifactOrigin: string,
  authenticated: (
    c: { req: { header(name: string): string | undefined } },
    privileged: boolean,
  ) => Promise<string | null>,
) {
  const origin = new URL(artifactOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== artifactOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("APP_ARTIFACT_ORIGIN must be an exact HTTPS origin");
  const respond = (c: Context, error: unknown) => {
    const code = (error as { code?: string }).code;
    if (code === "42501") return c.json({ error: "forbidden" }, 403);
    if (code === "P0002") return c.json({ error: "not_found" }, 404);
    if (code === "55000") return c.json({ error: "invalid_transition" }, 409);
    if (code === "22023") return c.json({ error: "invalid_request" }, 400);
    if (error instanceof Error && error.message === "body_too_large")
      return c.json({ error: "invalid_request" }, 413);
    if (
      error instanceof Error &&
      [
        "invalid_request",
        "invalid_manifest",
        "platform_version_unsupported",
      ].includes(error.message)
    )
      return c.json({ error: "invalid_request" }, 400);
    throw error;
  };
  app.get("/apps/published", async (c) =>
    c.json({ apps: await store.published() }),
  );
  app.get("/apps/review-queue", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    try {
      return c.json({ versions: await store.queue(id) });
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post("/apps/:appId/versions", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("appId");
    if (!slug.test(appId)) return c.json({ error: "invalid_request" }, 400);
    try {
      const body = await jsonBody(c);
      if (
        !object(body, ["manifest", "sha256"]) ||
        typeof body.sha256 !== "string" ||
        !hash.test(body.sha256)
      )
        throw new Error("invalid_request");
      const manifest = parseAppManifest(body.manifest);
      const sha256 = body.sha256.toLowerCase();
      const artifactUrl = `${artifactOrigin}/artifacts/${sha256}.html`;
      return c.json(
        await store.submit(id, appId, manifest, sha256, artifactUrl),
        201,
      );
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post("/apps/:appId/versions/:versionId/:decision", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const { appId, versionId, decision } = c.req.param();
    if (
      !slug.test(appId) ||
      !uuid.test(versionId) ||
      !["approve", "reject", "publish"].includes(decision)
    )
      return c.json({ error: "invalid_request" }, 400);
    try {
      if (decision === "publish") {
        const body = await jsonBody(c);
        if (!object(body, [])) throw new Error("invalid_request");
        return c.json(await store.publish(id, appId, versionId));
      }
      const body = await jsonBody(c);
      if (
        !object(body, ["reason"]) ||
        typeof body.reason !== "string" ||
        !body.reason.trim() ||
        body.reason.length > 500
      )
        throw new Error("invalid_request");
      return c.json(
        await store.review(
          id,
          appId,
          versionId,
          decision === "approve",
          body.reason,
        ),
      );
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post("/apps/:appId/rollback", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("appId");
    if (!slug.test(appId)) return c.json({ error: "invalid_request" }, 400);
    try {
      const body = await jsonBody(c);
      if (
        !object(body, ["versionId"]) ||
        typeof body.versionId !== "string" ||
        !uuid.test(body.versionId)
      )
        throw new Error("invalid_request");
      return c.json(await store.rollback(id, appId, body.versionId));
    } catch (error) {
      return respond(c, error);
    }
  });
  app.post("/apps/:appId/withdraw", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("appId");
    if (!slug.test(appId)) return c.json({ error: "invalid_request" }, 400);
    try {
      const body = await jsonBody(c);
      if (
        !object(body, ["reason"]) ||
        typeof body.reason !== "string" ||
        !body.reason.trim() ||
        body.reason.length > 500
      )
        throw new Error("invalid_request");
      return c.json(await store.withdraw(id, appId, body.reason));
    } catch (error) {
      return respond(c, error);
    }
  });
}
