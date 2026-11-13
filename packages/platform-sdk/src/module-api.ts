import type { ModuleStreamOptions } from "./module-stream.ts";
export type {
  ModuleStreamEvent,
  ModuleStreamOptions,
} from "./module-stream.ts";
/** Official app modules whose screens are built into the shell. */
export const OFFICIAL_MODULES = [
  "splash",
  "governance",
  "notifications",
  "treasury",
  "reputation",
] as const;
export type OfficialModule = (typeof OFFICIAL_MODULES)[number];

export type ModuleResponse = {
  status: number;
  /** Parsed JSON body, or null when the body is empty or not JSON. */
  body: unknown;
  /** Seconds from `Retry-After`, when the server sent a valid one. */
  retryAfter: number | null;
};
export type ModuleBody =
  { json: unknown } | { bytes: Blob; contentType: "image/png" };

/**
 * A client limited to one official module's own API (`/v1/<module>/...`). The
 * launch credential stays in the platform adapter: the module receives only
 * status codes and parsed bodies, never the header itself.
 */
export type ModuleApi = {
  /** Absolute URL of a public module resource, such as an image. */
  url(path: string): string;
  request(
    method: "GET" | "POST",
    path: string,
    options?: { body?: ModuleBody; auth?: boolean; signal?: AbortSignal },
  ): Promise<ModuleResponse>;
  stream?: (path: string, options: ModuleStreamOptions) => Promise<void>;
};

function reputationQuery(path: string, query: string): boolean {
  if (!query || query.length > 1024 || /[#%+]/.test(query)) return false;
  const allowed =
    path === "/v1/reputation/overview"
      ? ["view", "period", "cursor"]
      : path === "/v1/reputation/summary" ||
          /^\/v1\/reputation\/detail\/[0-9a-f-]{36}$/i.test(path)
        ? ["period"]
        : path === "/v1/reputation/items"
          ? ["period", "cursor"]
          : path === "/v1/reputation/missions"
            ? ["cursor"]
            : ["/v1/reputation/changes", "/v1/reputation/stream"].includes(path)
              ? ["after"]
              : [];
  const seen = new Set<string>();
  return query.split("&").every((pair) => {
    const [key, value, ...extra] = pair.split("=");
    if (
      !key ||
      !value ||
      extra.length ||
      !allowed.includes(key) ||
      seen.has(key)
    )
      return false;
    seen.add(key);
    return key === "view"
      ? /^(tasks|history)$/.test(value)
      : key === "period"
        ? /^(today|week|previous_week|all)$/.test(value)
        : key === "after"
          ? /^(0|[1-9][0-9]{0,19})$/.test(value)
          : /^[A-Za-z0-9_.~-]{1,512}$/.test(value);
  });
}

const segment = /^[A-Za-z0-9_.~%-]+$/;
/** Module paths without traversal or fragments; governance permits explicit cursors. */
export function modulePath(module: OfficialModule, path: string): string {
  const [pathname, query, ...extra] = path.split("?");
  if (
    extra.length ||
    (query !== undefined &&
      !(
        (module === "reputation" && reputationQuery(pathname ?? "", query)) ||
        (module === "treasury" &&
          /^\/v1\/treasury\/(transactions|config\/history)$/.test(
            pathname ?? "",
          ) &&
          /^(?:(?:before=[1-9][0-9]{0,17}|direction=(?:in|out)|token=(?:TON|JPEGPE))(?:&|$))+$/.test(
            query,
          )) ||
        (module === "governance" &&
          ((pathname === "/v1/governance/proposals" &&
            /^before=[0-9a-f-]{36}$/i.test(query)) ||
            (/^\/v1\/governance\/proposals\/[0-9a-f-]{36}\/votes$/i.test(
              pathname ?? "",
            ) &&
              /^after=\d{1,18}$/.test(query))))
      ))
  )
    throw new Error("invalid_request");
  const parts = (pathname ?? "").split("/");
  if (
    !OFFICIAL_MODULES.includes(module) ||
    parts[0] !== "" ||
    parts[1] !== "v1" ||
    parts[2] !== module ||
    parts.length < 4 ||
    parts.slice(3).some((part) => !segment.test(part) || /^\.+$/.test(part))
  )
    throw new Error("invalid_request");
  return path;
}

function retryAfter(value: string | null): number | null {
  if (!value || !/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}

export function moduleApiAdapter(
  apiBase: string,
  authHeaders: () => { Authorization: string } | null,
) {
  return {
    moduleApi(module: OfficialModule): ModuleApi {
      const url = (path: string) => `${apiBase}${modulePath(module, path)}`;
      return {
        url,
        async stream(path, options) {
          if (
            module !== "reputation" ||
            path.split("?")[0] !== "/v1/reputation/stream"
          )
            throw new Error("invalid_request");
          const target = url(path);
          const { openModuleStream } = await import("./module-stream.ts");
          await openModuleStream(target, options, authHeaders);
        },
        async request(method, path, options = {}) {
          const target = url(path);
          const auth = options.auth ?? true;
          const headers: Record<string, string> = {};
          if (auth) {
            const credential = authHeaders();
            if (!credential) throw new Error("expired");
            headers.Authorization = credential.Authorization;
          }
          let body: BodyInit | undefined;
          if (options.body && "json" in options.body) {
            headers["Content-Type"] = "application/json";
            body = JSON.stringify(options.body.json);
          } else if (options.body) {
            headers["Content-Type"] = options.body.contentType;
            body = options.body.bytes;
          }
          const response = await fetch(target, {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            credentials: "omit",
            cache: "no-store",
            signal: options.signal ?? null,
          });
          const parsed: unknown = await response.json().catch(() => null);
          if (auth && headers.Authorization !== authHeaders()?.Authorization)
            throw new Error("expired");
          return {
            status: response.status,
            body: parsed,
            retryAfter: retryAfter(response.headers.get("retry-after")),
          };
        },
      };
    },
  };
}
