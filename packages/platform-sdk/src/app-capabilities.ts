import { appSlug } from "./review-registry.ts";

export type AppReport = {
  reportId: string;
  appId: string;
  versionId: string;
  reporterId: string;
  category: "bug" | "content" | "privacy" | "other";
  text: string;
  createdAt: string;
};
export const capabilityOperation =
  /^(records\.(get|list|put|delete)|scores\.(submit|list|rank)|report)$/;
export function appCapabilitiesAdapter(
  apiBase: string,
  authHeaders: () => { Authorization: string } | null,
) {
  return {
    async appCapability(
      appId: string,
      hash: string,
      operation: string,
      payload: unknown,
      signal?: AbortSignal,
    ): Promise<unknown> {
      if (
        !appSlug.test(appId) ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        !capabilityOperation.test(operation)
      )
        throw new Error("invalid_request");
      const auth = authHeaders();
      if (!auth) throw new Error("capability_denied");
      const response = await fetch(
        `${apiBase}/apps/${appId}/capabilities/${operation}`,
        {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: JSON.stringify({ hash, payload }),
          credentials: "omit",
          cache: "no-store",
          signal: signal ?? null,
        },
      );
      const body: unknown = await response.json();
      if (!response.ok) {
        const error =
          body && typeof body === "object" && "error" in body
            ? body.error
            : null;
        throw new Error(
          typeof error === "string" &&
            [
              "capability_denied",
              "version_conflict",
              "limit_exceeded",
              "invalid_request",
              "rate_limited",
            ].includes(error)
            ? error
            : "request_failed",
        );
      }
      return body;
    },
    async readAppReports(signal?: AbortSignal): Promise<AppReport[]> {
      const auth = authHeaders();
      if (!auth) throw new Error("expired");
      const response = await fetch(`${apiBase}/apps/review-queue/reports`, {
        headers: auth,
        credentials: "omit",
        cache: "no-store",
        signal: signal ?? null,
      });
      if (!response.ok)
        throw new Error(response.status === 403 ? "forbidden" : "unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("reports" in value) ||
        !Array.isArray(value.reports) ||
        value.reports.length > 1000
      )
        throw new Error("unavailable");
      return value.reports.map((row: unknown) => {
        if (!row || typeof row !== "object") throw new Error("unavailable");
        const r = row as Record<string, unknown>;
        if (
          ![
            "reportId",
            "appId",
            "versionId",
            "reporterId",
            "category",
            "text",
            "createdAt",
          ].every((k) => typeof r[k] === "string") ||
          !["bug", "content", "privacy", "other"].includes(
            String(r.category),
          ) ||
          String(r.text).length > 1000
        )
          throw new Error("unavailable");
        return {
          reportId: r.reportId,
          appId: r.appId,
          versionId: r.versionId,
          reporterId: r.reporterId,
          category: r.category,
          text: r.text,
          createdAt: r.createdAt,
        } as AppReport;
      });
    },
  };
}

/** App identity and release hash come only from the trusted host release. */
export async function runAppCapability(options: {
  type: string;
  payload: unknown;
  appId: string;
  hash: string;
  granted: ReadonlySet<string>;
  readConsent(appId: string, permission: string): Promise<boolean>;
  request(operation: string, payload: unknown): Promise<unknown>;
}) {
  const operation = options.type.slice("rada.member.".length);
  if (!capabilityOperation.test(operation) || operation === "report")
    throw new Error("capability_denied");
  const permission = operation.startsWith("records.")
    ? "storage.self"
    : "scores";
  if (
    !options.granted.has(permission) ||
    !(await options.readConsent(options.appId, permission))
  )
    throw new Error("capability_denied");
  return options.request(operation, options.payload);
}
