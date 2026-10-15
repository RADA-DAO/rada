import type { Hono } from "hono";
import type { WalletLinkRequest, WalletStore } from "./store.ts";

type Authenticated = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;

async function smallJson(request: Request): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new Error("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 20_000) throw new Error("invalid_request");
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function validLink(value: unknown): value is WalletLinkRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) =>
        ![
          "address",
          "network",
          "walletStateInit",
          "publicKey",
          "proof",
        ].includes(key),
    )
  )
    return false;
  if (
    typeof item.address !== "string" ||
    item.address.length > 128 ||
    item.network !== "-239" ||
    typeof item.walletStateInit !== "string" ||
    item.walletStateInit.length > 16_000 ||
    (item.publicKey !== undefined &&
      (typeof item.publicKey !== "string" ||
        !/^[0-9a-f]{64}$/i.test(item.publicKey)))
  )
    return false;
  const proof = item.proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return false;
  const p = proof as Record<string, unknown>;
  if (
    Object.keys(p).some(
      (key) => !["timestamp", "domain", "payload", "signature"].includes(key),
    ) ||
    !(
      (typeof p.timestamp === "number" && Number.isSafeInteger(p.timestamp)) ||
      (typeof p.timestamp === "string" && /^(0|[1-9][0-9]*)$/.test(p.timestamp))
    ) ||
    typeof p.payload !== "string" ||
    !/^[0-9a-f]{64}$/.test(p.payload) ||
    typeof p.signature !== "string" ||
    p.signature.length > 256
  )
    return false;
  const domain = p.domain;
  if (!domain || typeof domain !== "object" || Array.isArray(domain))
    return false;
  const d = domain as Record<string, unknown>;
  return (
    Object.keys(d).length === 2 &&
    Number.isSafeInteger(d.lengthBytes) &&
    typeof d.value === "string" &&
    d.value.length <= 128
  );
}

export function registerWalletRoutes(
  app: Hono,
  store: WalletStore,
  authenticated: Authenticated,
) {
  app.post("/me/wallet/challenge", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json(await store.challenge(id));
  });
  app.post("/me/wallet/link", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await smallJson(c.req.raw);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (!validLink(body)) return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({ wallet: await store.link(id, body) });
    } catch (error) {
      if (error instanceof Error && error.message === "challenge_expired")
        return c.json({ error: "challenge_expired" }, 409);
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "54000"
      )
        return c.json({ error: "wallet_limit" }, 409);
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      )
        return c.json({ error: "wallet_already_linked" }, 409);
      return c.json({ error: "proof_rejected" }, 400);
    }
  });
  app.get("/me/wallet", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ wallets: await store.own(id) });
  });
  app.get("/me/wallet/history", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ events: await store.history(id) });
  });
  app.get("/me/wallet/balances", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ wallets: await store.ownBalances(id) });
  });
  app.post("/me/wallet/revoke", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try {
      body = await smallJson(c.req.raw);
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("address" in body) ||
      typeof body.address !== "string" ||
      body.address.length > 128
    )
      return c.json({ error: "invalid_request" }, 400);
    try {
      return c.json({ revoked: await store.revoke(id, body.address) });
    } catch {
      return c.json({ error: "invalid_request" }, 400);
    }
  });
  app.get("/apps/:appId/wallet/address", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("appId");
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(appId))
      return c.json({ error: "invalid_request" }, 400);
    const wallets = await store.appAddress(id, appId);
    if (!wallets) return c.json({ error: "capability_denied" }, 403);
    return c.json({
      wallets: wallets.map((wallet) => ({
        address: wallet.address,
        network: wallet.network,
      })),
    });
  });
  app.get("/apps/:appId/wallet/balances", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const appId = c.req.param("appId");
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(appId))
      return c.json({ error: "invalid_request" }, 400);
    const wallets = await store.appBalances(id, appId);
    if (!wallets) return c.json({ error: "capability_denied" }, 403);
    return c.json({
      wallets: wallets.map((item) => ({
        tonNano: item.balances.gram?.raw ?? null,
        jpegpeNano: item.balances.jpegpe?.raw ?? null,
      })),
    });
  });
}
