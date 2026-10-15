// Synthetic values only; no Telegram network calls are made by tests.
export const FIXTURE_TOKEN = "synthetic-fixture-bot-token";
export async function signed(
  overrides: Record<string, string> = {},
  token = FIXTURE_TOKEN,
): Promise<string> {
  const fields = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 101, username: "synthetic" }),
    ...overrides,
  });
  const data = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const secret = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token),
  );
  const signing = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", signing, new TextEncoder().encode(data)),
  );
  fields.set(
    "hash",
    [...digest].map((x) => x.toString(16).padStart(2, "0")).join(""),
  );
  return fields.toString();
}
export function assert(
  value: unknown,
  message = "Assertion failed",
): asserts value {
  if (!value) throw new Error(message);
}
