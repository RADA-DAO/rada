import type { AppRelease } from "./app-host.ts";
import {
  APP_PERMISSIONS,
  appIconUrl,
  parseAppManifest,
} from "./app-manifest.ts";
import { appSlug, versionUuid } from "./review-registry.ts";

/** A reviewed, published release the launcher may open. */
export type PublishedApp = AppRelease & {
  versionId: string;
  /** Where the approved icon would be fetched from, if the manifest names one. */
  iconUrl?: string;
};

const rowKeys = [
  "appId",
  "registryId",
  "versionId",
  "versionNo",
  "manifest",
  "sha256",
  "artifactUrl",
  "grantedPermissions",
];

function publishedApp(value: unknown): PublishedApp | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !rowKeys.includes(key)) ||
    typeof row.appId !== "string" ||
    !appSlug.test(row.appId) ||
    typeof row.versionId !== "string" ||
    !versionUuid.test(row.versionId) ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.artifactUrl !== "string" ||
    row.artifactUrl.length > 2048 ||
    !Array.isArray(row.grantedPermissions)
  )
    return null;
  let url: URL;
  try {
    url = new URL(row.artifactUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== `/artifacts/${row.sha256}.html` ||
    url.search ||
    url.hash
  )
    return null;
  let manifest: AppRelease["manifest"];
  try {
    manifest = parseAppManifest(row.manifest);
  } catch {
    return null;
  }
  const grants: unknown[] = row.grantedPermissions;
  if (
    grants.some(
      (permission) =>
        typeof permission !== "string" ||
        !(APP_PERMISSIONS as readonly string[]).includes(permission) ||
        !(manifest.permissions as readonly string[]).includes(permission),
    ) ||
    new Set(grants).size !== grants.length
  )
    return null;
  const iconUrl = appIconUrl(manifest, url.href, row.sha256);
  return {
    appId: row.appId,
    versionId: row.versionId,
    ...(iconUrl ? { iconUrl } : {}),
    manifest,
    artifactUrl: url.href,
    artifactSha256: row.sha256,
    grantedPermissions: grants as AppRelease["grantedPermissions"],
  };
}

/**
 * The registry's published list. A malformed or unsupported release is left
 * out so one bad row never hides every other app; a malformed envelope fails.
 */
export function parsePublishedApps(value: unknown): PublishedApp[] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("apps" in value) ||
    !Array.isArray(value.apps) ||
    value.apps.length > 1000
  )
    throw new Error("unavailable");
  const seen = new Set<string>();
  const apps: PublishedApp[] = [];
  for (const row of value.apps as unknown[]) {
    const app = publishedApp(row);
    if (!app || seen.has(app.appId)) continue;
    seen.add(app.appId);
    apps.push(app);
  }
  return apps;
}

export function publishedAppsAdapter(
  apiBase: string,
  authHeaders: () => { Authorization: string } | null,
) {
  return {
    /** Signed-in launches only; a guest has no launcher catalog yet. */
    async readPublishedApps(signal?: AbortSignal): Promise<PublishedApp[]> {
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(`${apiBase}/apps/published`, {
        headers,
        credentials: "omit",
        cache: "no-store",
        signal: signal ?? null,
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "expired" : "unavailable");
      return parsePublishedApps(await response.json());
    },
  };
}
