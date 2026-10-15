import pg from "pg";
import { readOwnPublicFrog, type PublicFrog } from "../../jpegpe/index.ts";
import { resolveTelegramSubject } from "./subject.ts";
import type { MembershipStatus } from "./membership.ts";

export type Me = {
  subject_id: string;
  profile:
    | { visibility: "private"; public: null }
    | {
        visibility: "public";
        public: PublicFrog;
      };
  membership: { status: MembershipStatus };
};
export interface IdentityStore {
  me(verifiedTelegramId: string): Promise<Me>;
  consents(
    verifiedTelegramId: string,
  ): Promise<{ app_id: string; capability: string }[]>;
  setConsent(
    verifiedTelegramId: string,
    appId: string,
    capability: string,
    grant: boolean,
  ): Promise<boolean>;
}

export class PostgresIdentityStore implements IdentityStore {
  constructor(
    private auth: pg.Pool,
    private service: pg.Pool,
  ) {}
  private async subject(verifiedTelegramId: string): Promise<string> {
    return resolveTelegramSubject(this.auth, verifiedTelegramId);
  }

  async consents(verifiedTelegramId: string) {
    const subjectId = await this.subject(verifiedTelegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subjectId,
      ]);
      const result = await client.query<{ app_id: string; capability: string }>(
        "SELECT app_id, capability FROM identity.consents WHERE revoked_at IS NULL ORDER BY app_id, capability",
      );
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async setConsent(
    verifiedTelegramId: string,
    appId: string,
    capability: string,
    grant: boolean,
  ) {
    const subjectId = await this.subject(verifiedTelegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subjectId,
      ]);
      if (grant) {
        await client.query(
          `INSERT INTO identity.consents(subject_id, app_id, capability) VALUES ($1, $2, $3)
           ON CONFLICT (subject_id, app_id, capability) DO UPDATE
           SET granted_at = now(), revoked_at = NULL`,
          [subjectId, appId, capability],
        );
      } else {
        await client.query(
          "UPDATE identity.consents SET revoked_at = now() WHERE subject_id = $1 AND app_id = $2 AND capability = $3 AND revoked_at IS NULL",
          [subjectId, appId, capability],
        );
      }
      await client.query("COMMIT");
      return grant;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async me(verifiedTelegramId: string): Promise<Me> {
    // The auth login has EXECUTE only; the read login cannot create identities.
    const subjectId = await this.subject(verifiedTelegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subjectId,
      ]);
      const own = await client.query<{
        subject_id: string;
        selected_frog_id: string | null;
      }>("SELECT subject_id, selected_frog_id FROM identity.subjects");
      if (own.rows.length !== 1 || own.rows[0].subject_id !== subjectId)
        throw new Error("Identity unavailable");
      const frog = own.rows[0].selected_frog_id
        ? await readOwnPublicFrog(client, own.rows[0].selected_frog_id)
        : null;
      await client.query("COMMIT");
      return {
        subject_id: subjectId,
        profile: frog
          ? { visibility: "public", public: frog }
          : { visibility: "private", public: null },
        membership: { status: "unavailable" },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async selectFrog(
    verifiedTelegramId: string,
    frogId: string | null,
  ): Promise<boolean> {
    const subjectId = await this.subject(verifiedTelegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subjectId,
      ]);
      const result = await client.query<{ selected: boolean }>(
        "SELECT identity.select_frog($1::uuid) AS selected",
        [frogId],
      );
      await client.query("COMMIT");
      return result.rows[0].selected;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
