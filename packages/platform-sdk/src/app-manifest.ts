export const PLATFORM_VERSION = "1.0.0";
export const APP_PERMISSIONS = [
  "identity.self.read",
  "theme.read",
  "navigation",
  "storage.self",
  "dao.public.read",
  "telegram.username.read",
  "wallet.address.read",
  "wallet.balances.read",
  "jpegpe.collection.read",
  "notifications.send",
  "money.exchange",
  "money.transfer",
  "frog.transfer",
  "wallet.sign",
  "governance.vote",
  "treasury.request",
  "frog.issue",
  "rewards.grant",
] as const;
export type AppPermission = (typeof APP_PERMISSIONS)[number];
export const CONSENT_PERMISSIONS = [
  "telegram.username.read",
  "wallet.address.read",
  "wallet.balances.read",
  "jpegpe.collection.read",
  "notifications.send",
] as const;
export type ConsentPermission = (typeof CONSENT_PERMISSIONS)[number];
export type AppManifest = {
  name: string;
  author: string;
  trustLevel: "community" | "official";
  designRoute: "standard" | "free-style";
  permissions: AppPermission[];
  minPlatformVersion: string;
  /** Square PNG, WebP or SVG inside the artifact's own folder; at most APP_ICON_MAX_BYTES. */
  icon?: string;
};
const requiredKeys = [
  "name",
  "author",
  "trustLevel",
  "designRoute",
  "permissions",
  "minPlatformVersion",
];
const keys = [...requiredKeys, "icon"];
export const APP_ICON_MAX_BYTES = 64 * 1024;
/** Relative, lower-case path of at most three segments; never absolute, hidden or climbing. */
export const APP_ICON_PATH =
  /^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63}){0,2}\.(?:png|webp|svg)$/;
/**
 * Where an approved release's icon lives: `/artifacts/<sha256>/<icon>` on the
 * artifact's own origin, so it is scoped to the hash the reviewer approved.
 */
export function appIconUrl(
  manifest: Pick<AppManifest, "icon">,
  artifactUrl: string,
  artifactSha256: string,
): string | undefined {
  if (!manifest.icon) return undefined;
  return `${new URL(artifactUrl).origin}/artifacts/${artifactSha256}/${manifest.icon}`;
}
const text = (value: unknown, limit: number) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= limit &&
  !/[\p{Cc}<>]/u.test(value);
export function parseAppManifest(value: unknown): AppManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_manifest");
  const input = value as Record<string, unknown>;
  if (
    requiredKeys.some((key) => !(key in input)) ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    ("icon" in input &&
      (typeof input.icon !== "string" || !APP_ICON_PATH.test(input.icon))) ||
    !text(input.name, 64) ||
    !text(input.author, 64) ||
    typeof input.trustLevel !== "string" ||
    !["community", "official"].includes(input.trustLevel) ||
    typeof input.designRoute !== "string" ||
    !["standard", "free-style"].includes(input.designRoute) ||
    !Array.isArray(input.permissions) ||
    input.permissions.length > APP_PERMISSIONS.length ||
    input.permissions.some(
      (permission) =>
        typeof permission !== "string" ||
        !APP_PERMISSIONS.includes(permission as AppPermission),
    ) ||
    new Set(input.permissions).size !== input.permissions.length ||
    typeof input.minPlatformVersion !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.minPlatformVersion)
  )
    throw new Error("invalid_manifest");
  const [major, minor, patch] = input.minPlatformVersion
    .split(".")
    .map(Number) as [number, number, number];
  const [hostMajor, hostMinor, hostPatch] = PLATFORM_VERSION.split(".").map(
    Number,
  ) as [number, number, number];
  if (
    major > hostMajor ||
    (major === hostMajor &&
      (minor > hostMinor || (minor === hostMinor && patch > hostPatch)))
  )
    throw new Error("platform_version_unsupported");
  return input as AppManifest;
}
