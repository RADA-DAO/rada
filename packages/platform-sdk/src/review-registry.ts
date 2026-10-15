import { parseAppManifest, type AppManifest } from "./app-manifest.ts";
export type ReviewVersion = {
  appId: string;
  versionId: string;
  versionNo: number;
  manifest: AppManifest;
  artifactSha256: string;
  artifactUrl: string;
};
export const appSlug = /^[a-z][a-z0-9_.:-]{0,127}$/;
export const versionUuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reviewVersion(value: unknown): ReviewVersion {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("unavailable");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some(
      (key) =>
        ![
          "appId",
          "versionId",
          "versionNo",
          "manifest",
          "sha256",
          "artifactUrl",
          "authorId",
          "createdAt",
        ].includes(key),
    ) ||
    typeof row.appId !== "string" ||
    !appSlug.test(row.appId) ||
    typeof row.versionId !== "string" ||
    !versionUuid.test(row.versionId) ||
    !Number.isSafeInteger(row.versionNo) ||
    Number(row.versionNo) < 1 ||
    typeof row.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.artifactUrl !== "string"
  )
    throw new Error("unavailable");
  const url = new URL(row.artifactUrl);
  if (
    row.artifactUrl.length > 2048 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== `/artifacts/${row.sha256}.html` ||
    url.search ||
    url.hash
  )
    throw new Error("unavailable");
  return {
    appId: row.appId,
    versionId: row.versionId,
    versionNo: Number(row.versionNo),
    manifest: parseAppManifest(row.manifest),
    artifactSha256: row.sha256,
    artifactUrl: url.href,
  };
}
export function parseReviewQueue(value: unknown): ReviewVersion[] {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !("versions" in value) ||
    !Array.isArray(value.versions) ||
    value.versions.length > 1000
  )
    throw new Error("unavailable");
  return value.versions.map(reviewVersion);
}
