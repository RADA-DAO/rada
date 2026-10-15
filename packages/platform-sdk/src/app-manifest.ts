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
};
const keys = [
  "name",
  "author",
  "trustLevel",
  "designRoute",
  "permissions",
  "minPlatformVersion",
];
const text = (value: unknown, limit: number) =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  value.length <= limit &&
  !/[\u0000-\u001f\u007f<>]/.test(value);
export function parseAppManifest(value: unknown): AppManifest {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_manifest");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
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
  const [major, minor, patch] = input.minPlatformVersion.split(".").map(Number);
  const [hostMajor, hostMinor, hostPatch] =
    PLATFORM_VERSION.split(".").map(Number);
  if (
    major > hostMajor ||
    (major === hostMajor &&
      (minor > hostMinor || (minor === hostMinor && patch > hostPatch)))
  )
    throw new Error("platform_version_unsupported");
  return input as AppManifest;
}
