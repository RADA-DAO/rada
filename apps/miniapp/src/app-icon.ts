import { APP_ICON_MAX_BYTES } from "../../../packages/platform-sdk/src/app-manifest.ts";

const types = new Set(["image/png", "image/webp", "image/svg+xml"]);

/**
 * Fetches an approved app icon and returns a local object URL, or nothing when
 * it is missing, too large or not a PNG, WebP or SVG. The tile then keeps its
 * monogram; a bad icon never blocks the launcher.
 */
export async function loadAppIcon(
  url: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal,
    });
    if (!response.ok) return undefined;
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > APP_ICON_MAX_BYTES) return undefined;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > APP_ICON_MAX_BYTES) return undefined;
    if (!types.has(blob.type)) return undefined;
    return URL.createObjectURL(blob);
  } catch {
    return undefined;
  }
}
