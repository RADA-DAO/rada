/** Client failure capture with fixed diagnostic codes and own-origin frames. */
export type ClientErrorReport = {
  kind: "error" | "unhandledrejection";
  name: string;
  message: DiagnosticCode;
  frames: string[];
  build: string;
  route: string;
};

export const MAX_REPORTS = 10;
export const MAX_FRAMES = 10;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BUILD = /^[0-9A-Za-z._-]{1,32}$/;
const ROUTE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const FILE = /^[A-Za-z0-9._-]{1,80}$/;

declare const __RADA_BUILD__: string | undefined;
/** Injected by Vite `define` (git short sha); "dev" when absent or malformed. */
export function buildVersion(): string {
  const value = typeof __RADA_BUILD__ === "string" ? __RADA_BUILD__ : "dev";
  return BUILD.test(value) ? value : "dev";
}

// Keep this allowlist in step with modules/ops/api/sanitize.ts and SQL.
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

function diagnosticCode(name: string): DiagnosticCode {
  switch (name) {
    case "TypeError":
      return "type_error";
    case "RangeError":
      return "range_error";
    case "ReferenceError":
      return "reference_error";
    case "SyntaxError":
      return "syntax_error";
    case "URIError":
      return "uri_error";
    case "EvalError":
      return "eval_error";
    case "AggregateError":
      return "aggregate_error";
    case "AbortError":
      return "abort_error";
    case "TimeoutError":
      return "timeout_error";
    default:
      return "unknown";
  }
}

/** Keeps only frames from `origin`, reduced to `file:line:col` (no path, no query). */
export function reduceStack(stack: string, origin: string): string[] {
  const frames: string[] = [];
  for (const match of stack
    .slice(0, 8000)
    .matchAll(/(https?:\/\/[^\s()]+?):(\d{1,6}):(\d{1,6})(?=\)|\s|$)/g)) {
    let url: URL;
    try {
      url = new URL(match[1] ?? "");
    } catch {
      continue;
    }
    const file = url.pathname.split("/").pop() ?? "";
    if (url.origin !== origin || !FILE.test(file)) continue;
    frames.push(`${file}:${match[2] ?? ""}:${match[3] ?? ""}`);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

export function buildReport(
  kind: ClientErrorReport["kind"],
  thrown: unknown,
  context: { origin: string; build: string; route: string },
): ClientErrorReport {
  const error = thrown instanceof Error ? thrown : undefined;
  const name = error?.name ?? "";
  return {
    kind,
    name: NAME.test(name) ? name : error ? "Error" : "NonError",
    message: diagnosticCode(name),
    frames: reduceStack(error?.stack ?? "", context.origin),
    build: BUILD.test(context.build) ? context.build : "dev",
    route: ROUTE.test(context.route) ? context.route : "other",
  };
}

type Target = Pick<Window, "addEventListener" | "removeEventListener">;
export type ClientErrorOptions = {
  endpoint: string;
  route: () => string;
  build?: string;
  origin?: string;
  target?: Target;
  send?: (endpoint: string, body: string) => void;
};

/** sendBeacon first; fetch with keepalive when the beacon is refused. text/plain keeps it preflight-free. */
export function transmit(endpoint: string, body: string): void {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain" }))
    )
      return;
  } catch {
    // Fall through to fetch.
  }
  void fetch(endpoint, {
    method: "POST",
    body,
    headers: { "Content-Type": "text/plain" },
    keepalive: true,
    credentials: "omit",
    cache: "no-store",
  }).catch(() => undefined);
}

/** At most MAX_REPORTS per page session; identical reports are sent once. */
export function installClientErrors(options: ClientErrorOptions): () => void {
  const target =
    options.target ?? (typeof window === "undefined" ? undefined : window);
  if (!target) return () => undefined;
  const origin = options.origin ?? location.origin;
  const build = options.build ?? buildVersion();
  const send = options.send ?? transmit;
  const seen = new Set<string>();
  const report = (kind: ClientErrorReport["kind"], thrown: unknown) => {
    try {
      if (seen.size >= MAX_REPORTS) return;
      const body = JSON.stringify(
        buildReport(kind, thrown, { origin, build, route: options.route() }),
      );
      if (seen.has(body)) return;
      seen.add(body);
      send(options.endpoint, body);
    } catch {
      // Reporting must never raise a second failure.
    }
  };
  const onError = (event: Event) => {
    const item = event as ErrorEvent;
    // Cross-origin script errors arrive without an Error object.
    report("error", item.error ?? item.message);
  };
  const onRejection = (event: Event) => {
    report("unhandledrejection", (event as PromiseRejectionEvent).reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
