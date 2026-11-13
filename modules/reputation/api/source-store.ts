import type pg from "pg";
import { resolveTelegramSubject } from "../../identity/index.ts";
import type { Evidence, ReputationItem } from "../contract.ts";
export type SourceFactInput = {
  source: string;
  sourceKey: string;
  title: string;
  description: string;
  occurredAt: string;
  evidence: Evidence[];
};
export type SourceFactReceipt = {
  item: ReputationItem;
  source: string;
  sourceKey: string;
};
/** Trusted server-only ingress. It records evidence; leased workers decide points. */
export class PostgresReputationSourceStore {
  private auth: pg.Pool;
  private ingress: pg.Pool;
  constructor(auth: pg.Pool, ingress: pg.Pool) {
    this.auth = auth;
    this.ingress = ingress;
  }
  async record(
    actor: string,
    input: SourceFactInput,
  ): Promise<SourceFactReceipt> {
    const stamp =
      /T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/.exec(
        input.occurredAt,
      );
    if (!stamp || /[1-9]/.test((stamp[1] ?? "").slice(6)))
      throw Object.assign(new Error("unsupported_source_time_precision"), {
        code: "22023",
      });
    const subject = await resolveTelegramSubject(this.auth, actor);
    const result = await this.ingress.query<{ result: SourceFactReceipt }>(
      "SELECT reputation.ingest_fact($1::uuid,$2,$3,$4,$5,$6::timestamptz,$7::jsonb) AS result",
      [
        subject,
        input.source,
        input.sourceKey,
        input.title,
        input.description,
        input.occurredAt,
        JSON.stringify(input.evidence),
      ],
    );
    return result.rows[0]!.result;
  }
}
