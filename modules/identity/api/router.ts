import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { IdentityStore } from "./store.ts";
import {
  unavailableMembership,
  type MembershipProvider,
  type MembershipStatus,
} from "./membership.ts";

export function registerIdentityRoutes(
  app: Hono,
  store: IdentityStore,
  authenticated: (
    c: { req: { header(name: string): string | undefined } },
    privileged: boolean,
  ) => Promise<string | null>,
  membership: MembershipProvider = unavailableMembership,
  syntheticOnly = false,
) {
  const consentCapabilities = new Set([
    "storage.self",
    "scores",
    "telegram.username.read",
    "wallet.address.read",
    "wallet.balances.read",
    "jpegpe.collection.read",
    "notifications.send",
  ]);
  app.get("/me/frogs", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ frogs: await store.ownFrogs(id) });
  });
  app.get("/me/frogs/:frogId", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const frogId = c.req.param("frogId");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        frogId,
      )
    )
      return c.json({ error: "invalid_request" }, 400);
    const detail = await store.frogDetails?.(id, frogId);
    return detail ? c.json(detail) : c.json({ error: "not_found" }, 404);
  });
  app.put("/me/profile-frog", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await readSmallJson(c.req.raw);
    } catch (error) {
      if (error instanceof HTTPException) return error.getResponse();
      throw error;
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "invalid_request" }, 400);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).length !== 1 ||
      !("frogId" in value) ||
      (value.frogId !== null &&
        (typeof value.frogId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value.frogId,
          )))
    )
      return c.json({ error: "invalid_request" }, 400);
    if (!(await store.selectFrog(id, value.frogId as string | null)))
      return c.json({ error: "not_owned" }, 409);
    return c.json({ selected: true });
  });
  app.get("/me/consents", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ consents: await store.consents(id) });
  });
  app.put("/me/consents", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const raw = c.req.header("Content-Type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(raw))
      return c.json({ error: "invalid_request" }, 400);
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: "invalid_request" }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.length;
        if (length > 1024) {
          await reader.cancel();
          return c.json({ error: "invalid_request" }, 413);
        }
        chunks.push(item.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    let bodyText: string;
    try {
      bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return c.json({ error: "invalid_request" }, 400);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).length !== 3 ||
      Object.keys(value).some(
        (key) => !["appId", "capability", "granted"].includes(key),
      ) ||
      typeof value.appId !== "string" ||
      !/^[a-z][a-z0-9_.:-]{0,127}$/.test(value.appId) ||
      typeof value.capability !== "string" ||
      !consentCapabilities.has(value.capability) ||
      typeof value.granted !== "boolean"
    )
      return c.json({ error: "invalid_request" }, 400);
    const granted = await store.setConsent(
      id,
      value.appId,
      value.capability,
      value.granted,
    );
    return c.json({ granted });
  });
  app.get("/me", async (c) => {
    const telegramId = await authenticated(c, false);
    if (!telegramId) return c.json({ error: "unauthorized" }, 401);
    const own = await store.me(telegramId);
    let status: MembershipStatus = "unavailable";
    try {
      if (!syntheticOnly) status = await membership.status(telegramId);
    } catch {
      /* Preserve own identity during provider failure. */
    }
    return c.json({ ...own, membership: { status } });
  });
}

async function readSmallJson(request: Request): Promise<unknown> {
  const raw = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(raw))
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request" }, { status: 400 }),
    });
  const reader = request.body?.getReader();
  if (!reader)
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request" }, { status: 400 }),
    });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 1024) {
        await reader.cancel();
        throw new HTTPException(413, {
          res: Response.json({ error: "invalid_request" }, { status: 413 }),
        });
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request" }, { status: 400 }),
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new HTTPException(400, {
      res: Response.json({ error: "invalid_request" }, { status: 400 }),
    });
  }

  return body;
}
