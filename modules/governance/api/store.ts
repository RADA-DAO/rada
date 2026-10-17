import type pg from "pg";
import type { MembershipProvider } from "../../identity/index.ts";
type IdentityGateway = {
  resolveTelegramSubject(auth: pg.Pool, actor: string): Promise<string>;
  governanceMembershipSnapshot(
    service: pg.Pool,
    provider: MembershipProvider,
  ): Promise<{ members: string[]; checkedAt: string }>;
};

export type Action =
  "create" | "open" | "withdraw" | "vote" | "decide" | "evidence" | "settings";
export interface GovernanceStore {
  list(before: string | null): Promise<unknown>;
  read(id: string): Promise<unknown>;
  votes(id: string, after: string): Promise<unknown>;
  mine(id: string): Promise<unknown>;
  settings(): Promise<unknown>;
  history(): Promise<unknown>;
  write(
    actor: string,
    action: Action,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  closeDue(): Promise<void>;
}

export class PostgresGovernanceStore implements GovernanceStore {
  private auth: pg.Pool;
  private service: pg.Pool;
  private membership: MembershipProvider;
  private identity: () => Promise<IdentityGateway>;
  constructor(
    auth: pg.Pool,
    service: pg.Pool,
    membership: MembershipProvider,
    identity: () => Promise<IdentityGateway> = () =>
      import("../../identity/index.ts"),
  ) {
    this.auth = auth;
    this.service = service;
    this.membership = membership;
    this.identity = identity;
  }

  private async query(sql: string, values: unknown[] = []) {
    const result = await this.service.query<{ result: unknown }>(sql, values);
    return result.rows[0]?.result ?? null;
  }
  list(before: string | null) {
    return this.query("SELECT governance.list_proposals($1::uuid) AS result", [
      before,
    ]);
  }
  read(id: string) {
    return this.query("SELECT governance.read_proposal($1::uuid) AS result", [
      id,
    ]);
  }
  votes(id: string, after: string) {
    return this.query(
      "SELECT governance.public_votes($1::uuid,$2::bigint) AS result",
      [id, after],
    );
  }
  settings() {
    return this.query("SELECT governance.current_settings() AS result");
  }
  history() {
    return this.query("SELECT governance.settings_history() AS result");
  }
  private async own(actor: string, sql: string, values: unknown[]) {
    const subject = await (
      await this.identity()
    ).resolveTelegramSubject(this.auth, actor);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id',$1,true)", [
        subject,
      ]);
      const result = await client.query<{ result: unknown }>(sql, values);
      await client.query("COMMIT");
      return result.rows[0]?.result ?? null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  mine(actor: string) {
    return this.own(actor, "SELECT governance.my_votes() AS result", []);
  }
  async write(actor: string, action: Action, input: Record<string, unknown>) {
    const { proposal_id: p } = input;
    if (action === "create" || action === "vote") {
      const checked = new Date().toISOString();
      const status = await this.membership.status(actor, true);
      if (status !== "member")
        throw Object.assign(new Error("membership_required"), {
          code: status === "unavailable" ? "membership_unavailable" : "42501",
        });
      return action === "create"
        ? this.own(
            actor,
            "SELECT governance.create_proposal($1,$2,$3,$4::timestamptz) AS result",
            [input.title, input.body, true, checked],
          )
        : this.own(
            actor,
            "SELECT governance.cast_vote($1::uuid,$2,$3,$4::timestamptz) AS result",
            [p, input.choice, true, checked],
          );
    }
    if (action === "open") {
      const settings = (await this.own(
        actor,
        "SELECT governance.open_context($1::uuid) AS result",
        [p],
      )) as {
        version: number;
        rules: { require_membership_at_open: boolean };
      };
      const snapshot = settings.rules.require_membership_at_open
        ? await (
            await this.identity()
          ).governanceMembershipSnapshot(this.service, this.membership)
        : { members: [], checkedAt: new Date().toISOString() };
      // The SQL function rechecks authorization and the current settings under lock.
      return this.own(
        actor,
        "SELECT governance.open_proposal($1::uuid,$2::uuid[],$3::timestamptz,$4::bigint) AS result",
        [p, snapshot.members, snapshot.checkedAt, settings.version],
      );
    }
    if (action === "withdraw")
      return this.own(
        actor,
        "SELECT governance.withdraw_proposal($1::uuid,$2) AS result",
        [p, input.reason],
      );
    if (action === "decide")
      return this.own(
        actor,
        "SELECT governance.decide($1::uuid,$2,$3) AS result",
        [p, input.outcome, input.reason],
      );
    if (action === "evidence")
      return this.own(
        actor,
        "SELECT governance.attach_evidence($1::uuid,$2,$3,$4) AS result",
        [p, input.body, input.tx_hash ?? null, input.link ?? null],
      );
    return this.own(
      actor,
      "SELECT governance.change_settings($1::jsonb,$2) AS result",
      [JSON.stringify(input.rules), input.reason],
    );
  }
  async closeDue() {
    const due = (await this.query(
      "SELECT governance.due_proposals() AS result",
    )) as {
      proposal_id: string;
      keep_departed_votes: boolean;
    }[];
    for (const proposal of due) {
      const snapshot = proposal.keep_departed_votes
        ? { members: null, checkedAt: new Date().toISOString() }
        : await (
            await this.identity()
          ).governanceMembershipSnapshot(this.service, this.membership);
      await this.query(
        "SELECT governance.close_proposal($1::uuid,$2::uuid[],$3::timestamptz) AS result",
        [proposal.proposal_id, snapshot.members, snapshot.checkedAt],
      );
    }
  }
}

/** No overlapping runs in a process; SQL row locks also serialize other replicas. */
export function startGovernanceScheduler(
  store: GovernanceStore,
  log: (line: string) => void,
) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await store.closeDue();
    } catch {
      log('{"event":"governance_close_failed"}');
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(() => {
    void run();
  }, 60_000);
}
