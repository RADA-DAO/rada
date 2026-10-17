import pg from "pg";
import { resolveTelegramSubject } from "../../identity/index.ts";
import type { PreparedImage } from "./image.ts";
import {
  insertBid,
  queryCurrentRound,
  queryOwnBids,
  queryNameStatus,
  queryRoundResults,
  runAdvanceRounds,
  type RoundStore,
} from "./rounds.ts";
import { PostgresImageStorage, type ImageStorage } from "./storage.ts";

export type PondFrog = {
  submissionId: string;
  submittedAt: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
  /** Present only when the author's profile is public (a selected frog). */
  author: {
    frogId: string;
    username: string;
    backgroundColor: string | null;
    accentColor: string | null;
  } | null;
};
export type OwnSubmission = {
  submissionId: string;
  state: "in_pond" | "won" | "claimed" | "burned";
  submittedAt: string;
  width: number;
  height: number;
  backgroundRemoved: boolean;
};
export type SubmitResult =
  | { status: "created"; submissionId: string; submittedAt: string }
  | { status: "rate_limited"; retryAfterSeconds: number }
  | { status: "duplicate" };

export interface SplashStore extends RoundStore {
  reserveSubmissionAttempt(telegramId: string): Promise<number>;
  submit(telegramId: string, image: PreparedImage): Promise<SubmitResult>;
  pond(): Promise<PondFrog[]>;
  mine(telegramId: string): Promise<OwnSubmission[]>;
  image(
    submissionId: string,
  ): Promise<{ contentType: string; bytes: Uint8Array } | null>;
}

type PondRow = {
  submission_id: string;
  submitted_at: Date;
  width: number;
  height: number;
  background_removed: boolean;
  author_frog_id: string | null;
  author_username: string | null;
  author_background_color: string | null;
  author_accent_color: string | null;
};
type OwnRow = Omit<
  PondRow,
  `author_${string}` | "submission_id" | "submitted_at"
> & {
  submission_id: string;
  state: OwnSubmission["state"];
  submitted_at: Date;
};

/** `auth` resolves Telegram ids to subjects; `service` holds only `splash_service`. */
export class PostgresSplashStore implements SplashStore {
  private auth: pg.Pool;
  private service: pg.Pool;
  private storage: ImageStorage;
  constructor(
    auth: pg.Pool,
    service: pg.Pool,
    storage: ImageStorage = new PostgresImageStorage(),
  ) {
    this.auth = auth;
    this.service = service;
    this.storage = storage;
  }
  private async inSubjectTransaction<T>(
    telegramId: string,
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const subject = await resolveTelegramSubject(this.auth, telegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subject,
      ]);
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async reserveSubmissionAttempt(telegramId: string): Promise<number> {
    return await this.inSubjectTransaction(telegramId, async (client) => {
      const result = await client.query<{ retry: number }>(
        "SELECT splash.reserve_submission_attempt() AS retry",
      );
      return result.rows[0]?.retry ?? 60;
    });
  }
  async submit(telegramId: string, image: PreparedImage) {
    const submissionId = crypto.randomUUID();
    try {
      return await this.inSubjectTransaction(
        telegramId,
        async (client): Promise<SubmitResult> => {
          const result = await client.query<{
            accepted_at: Date | null;
            retry_after_seconds: number;
          }>("SELECT * FROM splash.submit_frog($1::uuid)", [submissionId]);
          const row = result.rows[0];
          if (!row?.accepted_at)
            return {
              status: "rate_limited",
              retryAfterSeconds: row?.retry_after_seconds ?? 3600,
            };
          await this.storage.save(client, submissionId, image);
          return {
            status: "created",
            submissionId,
            submittedAt: row.accepted_at.toISOString(),
          };
        },
      );
    } catch (error) {
      // The same processed image (sha256) cannot be submitted twice.
      if ((error as { code?: string }).code === "23505")
        return { status: "duplicate" as const };
      throw error;
    }
  }
  async pond() {
    const result = await this.service.query<PondRow>(
      "SELECT * FROM splash.pond(100)",
    );
    return result.rows.map((row): PondFrog => ({
      submissionId: row.submission_id,
      submittedAt: row.submitted_at.toISOString(),
      width: row.width,
      height: row.height,
      backgroundRemoved: row.background_removed,
      author:
        row.author_frog_id && row.author_username
          ? {
              frogId: row.author_frog_id,
              username: row.author_username,
              backgroundColor: row.author_background_color,
              accentColor: row.author_accent_color,
            }
          : null,
    }));
  }
  async mine(telegramId: string) {
    return await this.inSubjectTransaction(telegramId, async (client) => {
      const result = await client.query<OwnRow>(
        "SELECT * FROM splash.my_submissions()",
      );
      return result.rows.map((row): OwnSubmission => ({
        submissionId: row.submission_id,
        state: row.state,
        submittedAt: row.submitted_at.toISOString(),
        width: row.width,
        height: row.height,
        backgroundRemoved: row.background_removed,
      }));
    });
  }
  async image(submissionId: string) {
    return await this.storage.load(this.service, submissionId);
  }
  async currentRound() {
    return await queryCurrentRound(this.service);
  }
  async placeBid(
    telegramId: string,
    submissionId: string,
    amount: string,
    username: string,
  ) {
    return await this.inSubjectTransaction(telegramId, (client) =>
      insertBid(client, submissionId, amount, username),
    );
  }
  async myBids(telegramId: string) {
    return await this.inSubjectTransaction(telegramId, queryOwnBids);
  }
  async roundResults(roundId: number) {
    return await queryRoundResults(this.service, roundId);
  }
  async nameStatus(name: string) {
    return await queryNameStatus(this.service, name);
  }
  async advanceRounds() {
    return await runAdvanceRounds(this.service);
  }
}

/**
 * For the bidding change: the author's subject id, so a bid by the author can be
 * refused. Uses the caller's service connection; returns null for unknown ids.
 */
export async function readSubmissionAuthor(
  client: Pick<pg.PoolClient, "query">,
  submissionId: string,
): Promise<string | null> {
  const result = await client.query<{ author: string | null }>(
    "SELECT splash.author_of($1::uuid) AS author",
    [submissionId],
  );
  return result.rows[0]?.author ?? null;
}
