export type FrogDetails = {
  creator: string | null;
  owner: string | null;
  colour_source: "proof" | "legacy_unverified";
  history: { at: string; from: string | null; to: string | null }[];
};
const publicName = (value: unknown) =>
  value === null ||
  (typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(value));
export function parseFrogDetails(value: unknown): FrogDetails {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("unavailable");
  const d = value as Record<string, unknown>;
  if (
    Object.keys(d).length !== 4 ||
    !publicName(d.creator) ||
    !publicName(d.owner) ||
    !["proof", "legacy_unverified"].includes(String(d.colour_source)) ||
    !Array.isArray(d.history) ||
    !d.history.every((e: unknown) => {
      if (!e || typeof e !== "object" || Array.isArray(e)) return false;
      const row = e as Record<string, unknown>;
      return (
        Object.keys(row).length === 3 &&
        publicName(row.from) &&
        publicName(row.to) &&
        typeof row.at === "string" &&
        Number.isFinite(Date.parse(row.at))
      );
    })
  )
    throw new Error("unavailable");
  return value as FrogDetails;
}

/** Credentials stay in the SDK; artwork URLs cannot choose a credential recipient. */
export function frogAdapter(
  profileUrl: string,
  authHeaders: () => { Authorization: string } | null,
) {
  const slots = Array.from({ length: 4 }, () => Promise.resolve());
  let nextSlot = 0;
  return {
    async readFrogDetails(frogId: string, signal: AbortSignal) {
      if (!/^[0-9a-f-]{36}$/i.test(frogId)) throw new Error("invalid_request");
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const response = await fetch(`${profileUrl}/frogs/${frogId}`, {
        headers,
        signal,
        credentials: "omit",
        cache: "no-store",
      });
      if (!response.ok) throw new Error("unavailable");
      return parseFrogDetails(await response.json());
    },
    async readFrogArtwork(path: string, signal: AbortSignal): Promise<Blob> {
      if (!/^\/v1\/frogs\/[0-9a-f-]{36}\/artwork\/[0-9a-f]{64}$/.test(path))
        throw new Error("invalid_artwork");
      const headers = authHeaders();
      if (!headers) throw new Error("expired");
      const slot = nextSlot++ % slots.length;
      const previous = slots[slot];
      let release = () => {};
      slots[slot] = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        signal.throwIfAborted();
        const response = await fetch(`${profileUrl.slice(0, -3)}${path}`, {
          headers,
          signal,
          credentials: "omit",
          redirect: "error",
          // Honor the server's immutable public / no-store private cache policy.
          cache: "default",
        });
        if (
          !response.ok ||
          !["image/png", "image/jpeg", "image/webp"].includes(
            response.headers.get("Content-Type") ?? "",
          )
        )
          throw new Error("invalid_artwork");
        const blob = await response.blob();
        if (blob.size > 4 * 1024 * 1024) throw new Error("invalid_artwork");
        return blob;
      } finally {
        release();
      }
    },
  };
}
