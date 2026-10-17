import { resolveTelegramSubject } from "../../identity/index.ts";
import pg from "pg";
import type { AppManifest } from "../../../packages/platform-sdk/src/app-manifest.ts";

export type SubmittedVersion = {
  appId: string;
  versionId: string;
  versionNo: number;
  status: string;
};
export interface RegistryStore {
  capability?(
    id: string,
    appId: string,
    hash: string,
    operation: string,
    payload: unknown,
  ): Promise<unknown>;
  reports?(id: string): Promise<unknown[]>;
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
  /** Authorized steward only: record or revoke official status with a reason. */
  setTier(
    id: string,
    appId: string,
    tier: "community" | "official",
    reason: string,
  ): Promise<{ appId: string; tier: string }>;
  /** Authorized steward only: who changed the tier, when and why. */
  tierChanges(id: string, appId: string): Promise<unknown[]>;
  published(): Promise<unknown[]>;
}

export class PostgresRegistryStore implements RegistryStore {
  private readonly auth: pg.Pool;
  private readonly service: pg.Pool;
  constructor(auth: pg.Pool, service: pg.Pool) {
    this.auth = auth;
    this.service = service;
  }

  private subject(telegramId: string): Promise<string> {
    return resolveTelegramSubject(this.auth, telegramId);
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
      if (!result.rows[0]) throw new Error("App query returned no result");
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
  setTier(
    id: string,
    appId: string,
    tier: "community" | "official",
    reason: string,
  ) {
    return this.own<{ appId: string; tier: string }>(
      id,
      "SELECT apps.set_tier($1,$2,$3) AS result",
      [appId, tier, reason],
    );
  }
  tierChanges(id: string, appId: string) {
    return this.own<unknown[]>(id, "SELECT apps.tier_changes($1) AS result", [
      appId,
    ]);
  }
  capability(
    id: string,
    appId: string,
    hash: string,
    operation: string,
    payload: unknown,
  ) {
    const [kind, action] = operation.split(".");
    if (operation === "report")
      return this.own<unknown>(
        id,
        "SELECT apps.report_problem($1,$2,$3::jsonb) AS result",
        [appId, hash, JSON.stringify(payload)],
      );
    const query =
      kind === "records"
        ? "SELECT apps.own_records($1,$2,$3,$4::jsonb) AS result"
        : kind === "scores"
          ? "SELECT apps.app_scores($1,$2,$3,$4::jsonb) AS result"
          : null;
    if (!query) throw new Error("invalid_request");
    return this.own<unknown>(id, query, [
      appId,
      hash,
      action,
      JSON.stringify(payload),
    ]);
  }
  reports(id: string) {
    return this.own<unknown[]>(id, "SELECT apps.report_queue() AS result");
  }
  async published() {
    const result = await this.service.query<{ result: unknown[] }>(
      "SELECT apps.published() AS result",
    );
    if (!result.rows[0])
      throw new Error("Published apps query returned no result");
    return result.rows[0].result;
  }
}
