import type { Hono } from "hono";
import { Address } from "@ton/ton";
import {
  PaymentConflict,
  PaymentDenied,
  PaymentExpired,
  type PaymentInput,
  type PostgresPaymentStore,
} from "./payments.ts";

type Authenticated = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const appSlug = /^[a-z][a-z0-9_.:-]{0,127}$/;
function validInput(value: unknown): value is PaymentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(",") !==
    "amount,appId,idempotencyKey,purpose,recipient,sender,token"
  )
    return false;
  if (
    typeof item.appId !== "string" ||
    !/^[a-z][a-z0-9_.:-]{0,127}$/.test(item.appId) ||
    typeof item.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(item.idempotencyKey) ||
    typeof item.token !== "string" ||
    !["TON", "JPEGPE"].includes(item.token) ||
    typeof item.amount !== "string" ||
    !/^[1-9][0-9]{0,76}$/.test(item.amount) ||
    BigInt(item.amount) > (1n << 120n) - 1n ||
    typeof item.purpose !== "string" ||
    item.purpose.trim() !== item.purpose ||
    !/^[\p{L}\p{N} .,!?_\-]{1,80}$/u.test(item.purpose)
  )
    return false;
  try {
    if (typeof item.sender !== "string" || typeof item.recipient !== "string")
      return false;
    if (
      (Address.isFriendly(item.sender) &&
        Address.parseFriendly(item.sender).isTestOnly) ||
      (Address.isFriendly(item.recipient) &&
        Address.parseFriendly(item.recipient).isTestOnly)
    )
      return false;
    const sender = Address.parse(item.sender),
      recipient = Address.parse(item.recipient);
    return (
      sender.workChain === 0 &&
      recipient.workChain === 0 &&
      !sender.equals(recipient)
    );
  } catch {
    return false;
  }
}
async function smallJson(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    ) ||
    Number(request.headers.get("content-length")) > 4096
  )
    throw new Error("invalid_request");
  const text = await request.text();
  if (text.length > 4096) throw new Error("invalid_request");
  return JSON.parse(text) as unknown;
}
export function registerPaymentRoutes(
  app: Hono,
  store: PostgresPaymentStore,
  authenticated: Authenticated,
) {
  app.post("/me/payments", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await smallJson(c.req.raw);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (!validInput(body)) return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({ payment: await store.prepare(id, body) });
    } catch (error) {
      if (error instanceof PaymentConflict)
        return c.json({ error: "idempotency_conflict" }, 409);
      if (error instanceof PaymentDenied)
        return c.json({ error: "forbidden" }, 403);
      throw error;
    }
  });
  app.post("/me/payments/:intentId/claim", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    if (!uuid.test(c.req.param("intentId")))
      return c.json({ error: "invalid_request" }, 400);
    const appId = c.req.query("appId");
    if (!appId || !appSlug.test(appId))
      return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json(await store.claim(id, appId, c.req.param("intentId")));
    } catch (error) {
      if (error instanceof PaymentDenied)
        return c.json({ error: "forbidden" }, 403);
      if (error instanceof PaymentExpired)
        return c.json({ error: "payment_expired" }, 409);
      throw error;
    }
  });
  app.post("/me/payments/:intentId/cancel", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    if (!uuid.test(c.req.param("intentId")))
      return c.json({ error: "invalid_request" }, 400);
    const appId = c.req.query("appId");
    if (!appId || !appSlug.test(appId))
      return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({
        payment: await store.cancel(id, appId, c.req.param("intentId")),
      });
    } catch (error) {
      if (error instanceof PaymentDenied)
        return c.json({ error: "forbidden" }, 403);
      throw error;
    }
  });
  app.get("/me/payments/:intentId", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    if (!uuid.test(c.req.param("intentId")))
      return c.json({ error: "invalid_request" }, 400);
    const appId = c.req.query("appId");
    if (!appId || !appSlug.test(appId))
      return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({
        payment: await store.reconcile(id, appId, c.req.param("intentId")),
      });
    } catch (error) {
      if (error instanceof PaymentDenied)
        return c.json({ error: "forbidden" }, 403);
      throw error;
    }
  });
}
