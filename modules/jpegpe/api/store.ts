import type pg from "pg";

export type PublicFrog = {
  frog_id: string;
  username: string;
  background_color: string | null;
  accent_color: string | null;
};

/** Keep the caller's transaction and verified subject context on this connection. */
export async function readOwnPublicFrog(
  client: pg.PoolClient,
  frogId: string,
): Promise<PublicFrog | null> {
  const result = await client.query<PublicFrog>(
    "SELECT * FROM jpegpe.own_public_frog($1::uuid)",
    [frogId],
  );
  return result.rows[0] ?? null;
}
