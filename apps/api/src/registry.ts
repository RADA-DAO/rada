import pg from "pg";
import type { AppManifest } from "../../../packages/platform-sdk/src/app-manifest.ts";

export type SubmittedVersion = {
  appId: string;
  versionId: string;
  versionNo: number;
  status: string;
};
export interface RegistryStore {
  submit(
    id: string,
    appId: string,
    manifest: AppManifest,
    sha256: string,
    artifactUrl: string,
  ): Promise<SubmittedVersion>;
  queue(id: string): Promise<unknown[]>;
  review(
    id: string,
    appId: string,
    versionId: string,
    approve: boolean,
    reason: string,
  ): Promise<SubmittedVersion>;
  publish(
    id: string,
    appId: string,
    versionId: string,
  ): Promise<SubmittedVersion>;
  rollback(
    id: string,
    appId: string,
    versionId: string,
  ): Promise<SubmittedVersion>;
  withdraw(
    id: string,
    appId: string,
    reason: string,
  ): Promise<SubmittedVersion>;
  published(): Promise<unknown[]>;
}

export class PostgresRegistryStore implements RegistryStore {
  constructor(
    private auth: pg.Pool,
    private service: pg.Pool,
  ) {}

  private async subject(telegramId: string): Promise<string> {
    const result = await this.auth.query<{ subject_id: string }>(
      "SELECT identity.resolve_telegram($1::bigint) AS subject_id",
      [telegramId],
    );
    return result.rows[0].subject_id;
  }

  private async own<T>(
    telegramId: string,
    query: string,
    values: unknown[] = [],
  ): Promise<T> {
    const subject = await this.subject(telegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      const result = await client.query<{ result: T }>(query, values);
      await client.query("COMMIT");
      return result.rows[0].result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  submit(
    id: string,
    appId: string,
    manifest: AppManifest,
    sha256: string,
    artifactUrl: string,
  ) {
    return this.own<SubmittedVersion>(
      id,
      "SELECT apps.submit_version($1,$2::jsonb,decode($3,'hex'),$4) AS result",
      [appId, JSON.stringify(manifest), sha256, artifactUrl],
    );
  }
  queue(id: string) {
    return this.own<unknown[]>(id, "SELECT apps.review_queue() AS result");
  }
  review(
    id: string,
    appId: string,
    versionId: string,
    approve: boolean,
    reason: string,
  ) {
    return this.own<SubmittedVersion>(
      id,
      "SELECT apps.review_version($1,$2::uuid,$3,$4) AS result",
      [appId, versionId, approve, reason],
    );
  }
  publish(id: string, appId: string, versionId: string) {
    return this.own<SubmittedVersion>(
      id,
      "SELECT apps.publish_version($1,$2::uuid) AS result",
      [appId, versionId],
    );
  }
  rollback(id: string, appId: string, versionId: string) {
    return this.own<SubmittedVersion>(
      id,
      "SELECT apps.rollback_version($1,$2::uuid) AS result",
      [appId, versionId],
    );
  }
  withdraw(id: string, appId: string, reason: string) {
    return this.own<SubmittedVersion>(
      id,
      "SELECT apps.withdraw_app($1,$2) AS result",
      [appId, reason],
    );
  }
  async published() {
    const result = await this.service.query<{ result: unknown[] }>(
      "SELECT apps.published() AS result",
    );
    return result.rows[0].result;
  }
}
