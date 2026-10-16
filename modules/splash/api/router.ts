import type { Hono } from "hono";
import { MAX_UPLOAD_BYTES, prepareImage, SubmissionRejected } from "./image.ts";
import type { SplashStore } from "./store.ts";

type Authenticated = (
  c: { req: { header(name: string): string | undefined } },
  privileged: boolean,
) => Promise<string | null>;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boundedBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new SubmissionRejected("invalid_image");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        throw new SubmissionRejected("too_large");
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
  return bytes;
}

/** Image URLs are relative to the API origin. */
const imagePath = (id: string) => `/v1/splash/submissions/${id}/image`;

export function registerSplashRoutes(
  app: Hono,
  store: SplashStore,
  authenticated: Authenticated,
) {
  app.post("/v1/splash/submissions", async (c) => {
    const id = await authenticated(c, true);
    if (!id) return c.json({ error: "unauthorized" }, 401);
    if (!/^image\/png(?:\s*;|$)/i.test(c.req.header("content-type") ?? ""))
      return c.json({ error: "unsupported_type" }, 415);
    if (Number(c.req.header("content-length") ?? 0) > MAX_UPLOAD_BYTES)
      return c.json({ error: "too_large" }, 413);
    let image;
    try {
      image = prepareImage(await boundedBody(c.req.raw));
    } catch (error) {
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
}
