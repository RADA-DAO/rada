import { BodyTooLarge, readBoundedBody } from "../../../packages/http/body.ts";
import { processingBudget } from "./processing-budget.ts";
import type { Hono } from "hono";
import { MAX_UPLOAD_BYTES, prepareImage, SubmissionRejected } from "./image.ts";
import type { ClaimService } from "./claim-service.ts";
import { registerClaimRoutes } from "./claims-router.ts";
import { registerRoundRoutes, type Authenticated } from "./rounds-router.ts";
import type { SplashStore } from "./store.ts";

const budget = processingBudget();

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Image URLs are relative to the API origin. */
const imagePath = (id: string) => `/v1/splash/submissions/${id}/image`;

export function registerSplashRoutes(
  app: Hono,
  store: SplashStore,
  authenticated: Authenticated,
  claims?: ClaimService,
) {
  app.post("/v1/splash/submissions", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const release = budget.acquire();
    if (!release) {
      c.header("Retry-After", "1");
      return c.json({ error: "rate_limited" }, 429);
    }
    try {
      if (!/^image\/png(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
        return c.json({ error: "unsupported_type" }, 415);
      const retry = await store.reserveSubmissionAttempt(id);
      if (retry > 0) {
        c.header("Retry-After", String(retry));
        return c.json({ error: "rate_limited" }, 429);
      }
      let image;
      try {
        image = prepareImage(
          await readBoundedBody(c.req.raw, MAX_UPLOAD_BYTES),
        );
      } catch (error) {
        if (error instanceof BodyTooLarge)
          return c.json({ error: "too_large" }, 413);
        if (!(error instanceof SubmissionRejected)) throw error;
        const status =
          error.code === "too_large"
            ? 413
            : error.code === "unsupported_type"
              ? 415
              : 400;
        return c.json({ error: error.code }, status);
      }
      const result = await store.submit(id, image);
      if (result.status === "rate_limited") {
        c.header("Retry-After", String(result.retryAfterSeconds));
        return c.json({ error: "rate_limited" }, 429);
      }
      if (result.status === "duplicate")
        return c.json({ error: "duplicate_image" }, 409);
      return c.json(
        {
          submission_id: result.submissionId,
          state: "in_pond",
          submitted_at: result.submittedAt,
          width: image.width,
          height: image.height,
          background_removed: image.backgroundRemoved,
          image_path: imagePath(result.submissionId),
        },
        201,
      );
    } finally {
      release();
    }
  });
  app.get("/v1/splash/pond", async (c) => {
    const frogs = await store.pond();
    return c.json({
      frogs: frogs.map((frog) => ({
        submission_id: frog.submissionId,
        submitted_at: frog.submittedAt,
        width: frog.width,
        height: frog.height,
        background_removed: frog.backgroundRemoved,
        image_path: imagePath(frog.submissionId),
        author: frog.author && {
          frog_id: frog.author.frogId,
          username: frog.author.username,
          background_color: frog.author.backgroundColor,
          accent_color: frog.author.accentColor,
        },
      })),
    });
  });
  app.get("/v1/splash/submissions/mine", async (c) => {
    const id = await authenticated(c, false);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    const submissions = await store.mine(id);
    return c.json({
      submissions: submissions.map((item) => ({
        submission_id: item.submissionId,
        state: item.state,
        submitted_at: item.submittedAt,
        width: item.width,
        height: item.height,
        background_removed: item.backgroundRemoved,
        image_path: imagePath(item.submissionId),
      })),
    });
  });
  app.get("/v1/splash/submissions/:id/image", async (c) => {
    const submissionId = c.req.param("id");
    if (!UUID.test(submissionId)) return c.json({ error: "not_found" }, 404);
    const stored = await store.image(submissionId);
    if (!stored) return c.json({ error: "not_found" }, 404);
    c.header("X-Content-Type-Options", "nosniff");
    // Content never changes for an id; the global no-store would defeat caching.
    c.header("Cache-Control", "public, max-age=3600, immutable");
    c.header("Content-Type", stored.contentType);
    return c.body(new Uint8Array(stored.bytes), 200);
  });
  registerRoundRoutes(app, store, authenticated);
  // Claims need the wallet payment store; without it the routes do not exist.
  if (claims) registerClaimRoutes(app, claims, authenticated);
}
