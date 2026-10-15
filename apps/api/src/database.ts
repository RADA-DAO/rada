import pg from "pg";

export type Me = {
  subject_id: string;
  profile: { visibility: "private"; public: null };
  membership: { status: "unavailable" };
};
export interface IdentityStore {
  me(verifiedTelegramId: string): Promise<Me>;
}

export class PostgresIdentityStore implements IdentityStore {
  constructor(
    private auth: pg.Pool,
    private service: pg.Pool,
  ) {}
  async me(verifiedTelegramId: string): Promise<Me> {
    // The auth login has EXECUTE only; the read login cannot create identities.
    const resolved = await this.auth.query<{ subject_id: string }>(
      "SELECT identity.resolve_telegram($1::bigint) AS subject_id",
      [verifiedTelegramId],
    );
    const subjectId = resolved.rows[0].subject_id;
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subjectId,
      ]);
      const own = await client.query<{ subject_id: string }>(
        "SELECT subject_id FROM identity.subjects",
      );
      if (own.rows.length !== 1 || own.rows[0].subject_id !== subjectId)
        throw new Error("Identity unavailable");
      await client.query("COMMIT");
      // JPEGPE ownership and live public projection are not available yet.
      return {
        subject_id: subjectId,
        profile: { visibility: "private", public: null },
        membership: { status: "unavailable" },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
