import type pg from "pg";
import { decodeItemCursor, encodeItemCursor } from "./cursor.ts";
import { resolveTelegramSubject } from "../../identity/index.ts";
import type {
  Appeal,
  AppealInput,
  Changes,
  CommandResult,
  Mission,
  Page,
  Period,
  ReportInput,
  ReputationItem,
  ReputationStore,
  Summary,
  VerifyInput,
} from "../contract.ts";

/** Runtime login inherits reputation_service only; auth pool is separate. */
export class PostgresReputationStore implements ReputationStore {
  private auth: pg.Pool;
  private pool: pg.Pool;
  constructor(auth: pg.Pool, pool: pg.Pool) {
    this.auth = auth;
    this.pool = pool;
  }
  private async own<T>(
    actor: string,
    sql: string,
    values: unknown[] = [],
  ): Promise<T> {
    const subject = await resolveTelegramSubject(this.auth, actor);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      const result = await client.query<{ result: T }>(sql, values);
      await client.query("COMMIT");
      return result.rows[0]!.result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  summary(actor: string, period: Period): Promise<Summary> {
    return this.own(actor, "SELECT reputation.summary($1) AS result", [period]);
  }
  missions(actor: string, cursor: string | null): Promise<Page<Mission>> {
    return this.own(
      actor,
      "SELECT reputation.read_missions($1::uuid) AS result",
      [cursor],
    );
  }
  async items(
    actor: string,
    period: Period,
    cursor: string | null,
  ): Promise<Page<ReputationItem>> {
    const page = await this.own<Page<ReputationItem>>(
      actor,
      "SELECT reputation.read_items($1,$2::jsonb) AS result",
      [period, cursor === null ? null : decodeItemCursor(cursor)],
    );
    return {
      ...page,
      nextCursor:
        page.nextCursor === null ? null : encodeItemCursor(page.nextCursor),
    };
  }

  item(actor: string, id: string): Promise<ReputationItem | null> {
    return this.own(actor, "SELECT reputation.read_item($1::uuid) AS result", [
      id,
    ]);
  }
  verify(
    actor: string,
    missionId: string,
    input: VerifyInput,
  ): Promise<CommandResult> {
    return this.own(
      actor,
      "SELECT reputation.verify($1::uuid,$2,$3) AS result",
      [missionId, input.missionVersion, input.requestId],
    );
  }
  report(actor: string, input: ReportInput): Promise<CommandResult> {
    return this.own(
      actor,
      "SELECT reputation.report($1,$2,$3,$4::timestamptz,$5) AS result",
      [
        input.requestId,
        input.title,
        input.description,
        input.occurredAt,
        input.evidenceUrl ?? null,
      ],
    );
  }
  command(actor: string, requestId: string): Promise<CommandResult | null> {
    return this.own(actor, "SELECT reputation.command($1) AS result", [
      requestId,
    ]);
  }
  changes(actor: string, after: string): Promise<Changes> {
    return this.own(actor, "SELECT reputation.changes($1::bigint) AS result", [
      after,
    ]);
  }
  appeal(actor: string, itemId: string, input: AppealInput): Promise<Appeal> {
    return this.own(
      actor,
      "SELECT reputation.appeal($1::uuid,$2,$3) AS result",
      [itemId, input.requestId, input.message],
    );
  }
  appeals(actor: string, itemId: string): Promise<Appeal[]> {
    return this.own(
      actor,
      "SELECT reputation.read_appeals($1::uuid) AS result",
      [itemId],
    );
  }
}
