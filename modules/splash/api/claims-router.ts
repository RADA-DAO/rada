import type { Hono } from "hono";
import { Address } from "@ton/ton";
import type { ClaimService, StartResult } from "./claim-service.ts";
import type { OwnClaim } from "./claims.ts";
import type { Authenticated } from "./rounds-router.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 1024;
type Refusal = Exclude<StartResult["status"], "ready" | "paid">;
const refusalStatus: Record<Refusal, 400 | 403 | 404 | 409 | 503> = {
  not_found: 404,
  not_winner: 403,
  wallet_not_linked: 403,
  already_claimed: 409,
  burned: 409,
  claim_expired: 409,
  name_fixed: 409,
  name_taken: 409,
  payment_pending: 409,
  conflict: 409,
  name_required: 400,
  invalid_name: 400,
  recipient_unset: 503,
};

/** A mainnet basechain address as raw `0:<hex>`, or null. */
export function rawMainnetAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  try {
    if (Address.isFriendly(value) && Address.parseFriendly(value).isTestOnly)
      return null;
    const address = Address.parse(value);
    return address.workChain === 0 ? address.toRawString().toLowerCase() : null;
  } catch {
    return null;
  }
}

async function smallJson(
  request: Request,
): Promise<Record<string, unknown> | "too_large" | "invalid_body"> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY)
    return "too_large";
  const text = await request.text();
  if (text.length > MAX_BODY) return "too_large";
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : "invalid_body";
  } catch {
    return "invalid_body";
  }
}

/** Returns the claim start input, or the error code for a 400 response. */
export function parseClaimStart(
  body: Record<string, unknown>,
):
  | { sender: string; username: string | null }
  | "invalid_body"
  | "invalid_name" {
  const sender = rawMainnetAddress(body.sender);
  if (!sender) return "invalid_body";
  const { name } = body;
  if (name === undefined || name === null) return { sender, username: null };
  // The naming rule itself belongs to JPEGPE and is checked in SQL.
  if (typeof name !== "string" || name.length < 1 || name.length > 32)
    return "invalid_name";
  return { sender, username: name };
}

const claimView = (claim: OwnClaim) => ({
  submission_id: claim.submissionId,
  round_id: claim.roundId,
  amount: claim.amount,
  name: claim.username,
  name_outcome: claim.nameOutcome,
  claim_deadline: claim.claimDeadline,
  state: claim.state,
  frog:
    claim.state === "claimed"
      ? {
          frog_id: claim.submissionId,
          username: claim.username,
          background_color: claim.backgroundColor,
          accent_color: claim.accentColor,
        }
      : null,
  payment: claim.intentId
    ? { intent_id: claim.intentId, status: claim.paymentStatus }
    : null,
});

export function registerClaimRoutes(
  app: Hono,
  claims: ClaimService,
  authenticated: Authenticated,
) {
  app.get("/v1/splash/claims/mine", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    return c.json({ claims: (await claims.mine(id)).map(claimView) });
  });
  app.get("/v1/splash/claims/:frogId", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const frogId = c.req.param("frogId");
    if (!UUID.test(frogId)) return c.json({ error: "not_found" }, 404);
    const claim = await claims.status(id, frogId.toLowerCase());
    if (!claim) return c.json({ error: "not_found" }, 404);
    return c.json({ claim: claimView(claim) });
  });
  // Starts or resumes the claim; the payment is the intent for the payment window.
  app.post("/v1/splash/claims/:frogId", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const frogId = c.req.param("frogId");
    if (!UUID.test(frogId)) return c.json({ error: "not_found" }, 404);
    const body = await smallJson(c.req.raw);
    if (body === "too_large") return c.json({ error: body }, 413);
    if (body === "invalid_body") return c.json({ error: body }, 400);
    const input = parseClaimStart(body);
    if (typeof input === "string") return c.json({ error: input }, 400);
    const result = await claims.start(
      id,
      frogId.toLowerCase(),
      input.sender,
      input.username,
    );
    if (result.status === "ready" || result.status === "paid")
      return c.json({ status: result.status, payment: result.payment });
    return c.json(
      {
        error: result.status,
        ...("payment" in result ? { payment: result.payment } : {}),
      },
      refusalStatus[result.status],
    );
  });
  // Steward only: the address that receives claim payments.
  app.put("/v1/splash/settings/recipient", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const body = await smallJson(c.req.raw);
    if (body === "too_large") return c.json({ error: body }, 413);
    if (body === "invalid_body") return c.json({ error: body }, 400);
    const recipient = rawMainnetAddress(body.address);
    if (!recipient) return c.json({ error: "invalid_address" }, 400);
    const saved = await claims.setRecipient(id, recipient);
    if (!saved) return c.json({ error: "forbidden" }, 403);
    return c.json({ recipient: saved.recipient, set_at: saved.setAt });
  });
}
