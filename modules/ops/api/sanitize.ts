// Server-side re-sanitization. The client already sanitizes; this never trusts it.
// Keep the diagnostic allowlist in step with the SDK and SQL.
export type ClientErrorReport = {
  kind: "error" | "unhandledrejection";
  name: string;
  message: DiagnosticCode;
  frames: string[];
  build: string;
  route: string;
};

export const MAX_FRAMES = 10;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BUILD = /^[0-9A-Za-z._-]{1,32}$/;
const ROUTE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const FRAME = /^[A-Za-z0-9._-]{1,80}:\d{1,6}:\d{1,6}$/;
const KEYS = ["kind", "name", "message", "frames", "build", "route"];

export const DIAGNOSTIC_CODES = [
  "unknown",
  "type_error",
  "range_error",
  "reference_error",
  "syntax_error",
  "uri_error",
  "eval_error",
  "aggregate_error",
  "abort_error",
  "timeout_error",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export function isDiagnosticCode(value: unknown): value is DiagnosticCode {
  return DIAGNOSTIC_CODES.some((code) => code === value);
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
    !isDiagnosticCode(message) ||
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
    message,
    frames: (frames as string[])
      .filter((frame) => FRAME.test(frame))
      .slice(0, MAX_FRAMES),
    build,
    route: ROUTE.test(route) ? route : "other",
  };
}
