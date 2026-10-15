import type pg from "pg";

/** Resolve only an already verified Telegram identifier using the auth login. */
export async function resolveTelegramSubject(
  auth: pg.Pool,
  verifiedTelegramId: string,
): Promise<string> {
  const result = await auth.query<{ subject_id: string }>(
    "SELECT identity.resolve_telegram($1::bigint) AS subject_id",
    [verifiedTelegramId],
  );
  return result.rows[0].subject_id;
}
