/** Cursor is transport-opaque and contains only a timestamp and item UUID. */
export function decodeItemCursor(cursor: string): string {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error("invalid_cursor");
  const raw = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_cursor");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join(",") !== "at,id" ||
    typeof v.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      v.id,
    ) ||
    typeof v.at !== "string" ||
    !Number.isFinite(Date.parse(v.at))
  )
    throw new Error("invalid_cursor");
  return raw;
}
export function encodeItemCursor(raw: string): string {
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
