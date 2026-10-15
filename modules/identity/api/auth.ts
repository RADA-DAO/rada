export const SESSION_TTL = { ordinary: 86_400, privileged: 3_600 } as const;
export type SessionKind = keyof typeof SESSION_TTL;
const encoder = new TextEncoder();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++)
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", imported, encoder.encode(data)),
  );
}

// One canonical bot token binds every accepted request to the platform audience.
export async function verifyTelegramInitData(
  raw: string,
  token: string,
  kind: SessionKind = "ordinary",
  now = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (!raw || raw.length > 12_000 || !token) return null;
  const values = new URLSearchParams(raw);
  const keys = [...values.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const hash = values.get("hash") ?? "";
  const date = values.get("auth_date") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hash) || !/^[1-9][0-9]*$/.test(date)) return null;
  const authDate = Number(date);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate < now - SESSION_TTL[kind] ||
    authDate > now + 120
  )
    return null;
  // Optional signature participates in HMAC verification; only hash is excluded.
  values.delete("hash");
  const data = [...values.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = await hmac(encoder.encode("WebAppData"), token);
  const actual = await hmac(secret, data);
  const expected = Uint8Array.from(
    hash.match(/../g)!.map((part) => parseInt(part, 16)),
  );
  if (!equalBytes(actual, expected)) return null;
  try {
    const user: unknown = JSON.parse(values.get("user") ?? "");
    if (
      !user ||
      typeof user !== "object" ||
      !("id" in user) ||
      typeof user.id !== "number" ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0
    )
      return null;
    return String(user.id);
  } catch {
    return null;
  }
}
