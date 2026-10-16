// Server-side re-sanitization. The client already sanitizes; this never trusts it.
// Keep the redaction rules in step with packages/platform-sdk/src/client-errors.ts.
export type ClientErrorReport = {
  kind: "error" | "unhandledrejection";
  name: string;
  message: string;
  frames: string[];
  build: string;
  route: string;
};

export const MAX_MESSAGE = 120;
export const MAX_FRAMES = 10;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BUILD = /^[0-9A-Za-z._-]{1,32}$/;
const ROUTE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const FRAME = /^[A-Za-z0-9._-]{1,80}:\d{1,6}:\d{1,6}$/;
const KEYS = ["kind", "name", "message", "frames", "build", "route"];

export function sanitizeMessage(value: string): string {
  return value
    .slice(0, 1000)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S+/gi, "<url>")
    .replace(/[^\s@<>()]+@[^\s@<>()]+/g, "<email>")
    .replace(/-?\d+:[0-9a-fA-F]{64}/g, "<addr>")
    .replace(/\b(?:0x)?[0-9a-fA-F]{8,}\b/g, "<hex>")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "<addr>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}

/** Returns a clean report, or null when the shape is not exactly the contract. */
export function parseReport(value: unknown): ClientErrorReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== KEYS.length || keys.some((key) => !KEYS.includes(key)))
    return null;
  const { kind, name, message, frames, build, route } = item;
  if (
    (kind !== "error" && kind !== "unhandledrejection") ||
    typeof name !== "string" ||
    typeof message !== "string" ||
    message.length > 2000 ||
    !Array.isArray(frames) ||
    frames.length > 50 ||
    frames.some((frame) => typeof frame !== "string") ||
    typeof build !== "string" ||
    !BUILD.test(build) ||
    typeof route !== "string" ||
    route.length > 200
  )
    return null;
  return {
    kind,
    name: NAME.test(name) ? name : "Error",
    message: sanitizeMessage(message),
    frames: (frames as string[])
      .filter((frame) => FRAME.test(frame))
      .slice(0, MAX_FRAMES),
    build,
    route: ROUTE.test(route) ? route : "other",
  };
}
