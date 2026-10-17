import type pg from "pg";
import { message, type Kind } from "./templates.ts";

export interface NotificationConfig {
  enabled: boolean;
  token: string;
  allowed: string[] | null;
}
export function notificationConfig(
  env: Record<string, string | undefined>,
): NotificationConfig {
  const staging =
    env.STAGING_RUNTIME === "true" || env.STAGING_AUTH_MODE === "allowlist";
  const synthetic = env.STAGING_AUTH_MODE === "synthetic";
  const allowed = (env.STAGING_ALLOWED_TELEGRAM_IDS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  if (
    staging &&
    !synthetic &&
    (!allowed.length || allowed.some((v) => !/^[1-9]\d{0,19}$/.test(v)))
  )
    throw new Error("Invalid notification allowlist");
  return {
    enabled: env.NOTIFICATIONS_ENABLED === "true" && !synthetic,
    token: env.TELEGRAM_BOT_TOKEN ?? "",
    allowed: staging || synthetic ? allowed : null,
  };
}
export type Outcome = {
  result: "sent" | "retry" | "dead" | "uncertain";
  delay: number;
};
export async function sendTelegram(
  token: string,
  destination: string,
  text: string,
  send: typeof fetch = fetch,
): Promise<Outcome> {
  try {
    const response = await send(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: destination,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (response.ok && body.ok === true) return { result: "sent", delay: 0 };
    const code = body.error_code ?? response.status;
    const delay = body.parameters?.retry_after;
    return {
      result: code === 429 || code >= 500 ? "retry" : "dead",
      delay:
        typeof delay === "number" && Number.isFinite(delay)
          ? Math.min(86400, Math.max(0, Math.ceil(delay)))
          : 0,
    };
  } catch {
    // Timeout/disconnect can mean Telegram accepted the message. Never blind-retry.
    return { result: "uncertain", delay: 0 };
  }
}
export class NotificationWorker {
  private pool: pg.Pool;
  private config: NotificationConfig;
  private send: typeof fetch;
  private running = false;
  constructor(
    pool: pg.Pool,
    config: NotificationConfig,
    send: typeof fetch = fetch,
  ) {
    this.pool = pool;
    this.config = config;
    this.send = send;
  }
  async run(): Promise<void> {
    if (this.running || !this.config.enabled || !this.config.token) return;
    this.running = true;
    let client: pg.PoolClient | undefined;
    let locked = false;
    try {
      client = await this.pool.connect();
      locked =
        (
          await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(726232450) AS locked",
          )
        ).rows[0]?.locked ?? false;
      if (!locked) return;
      await client.query("SELECT notifications.recover()");
      await client.query("SELECT splash.notification_reminders()");
      await client.query("SELECT governance.notification_reminders()");
      for (let i = 0; i < 20; i++) {
        const row = (
          await client.query<{
            event: { id: string; kind: Kind; locale: "en" | "uk" } | null;
          }>("SELECT notifications.reserve($1::text[]) AS event", [
            this.config.allowed,
          ])
        ).rows[0]?.event;
        if (!row) break;
        await client.query("BEGIN");
        const destination = (
          await client.query<{ destination: string | null }>(
            "SELECT notifications.authorize($1::bigint) AS destination",
            [row.id],
          )
        ).rows[0]?.destination;
        const outcome =
          destination &&
          (this.config.allowed === null ||
            this.config.allowed.includes(destination))
            ? await sendTelegram(
                this.config.token,
                destination,
                message(row.locale, row.kind),
                this.send,
              )
            : { result: "dead", delay: 0 };
        await client.query("SELECT notifications.finish($1::bigint,$2,$3)", [
          row.id,
          outcome.result,
          outcome.delay,
        ]);
        await client.query("COMMIT");
      }
    } catch {
      if (client) await client.query("ROLLBACK").catch(() => {});
      console.log('{"event":"notification_worker_failed"}');
    } finally {
      if (client) {
        if (locked)
          await client
            .query("SELECT pg_advisory_unlock(726232450)")
            .catch(() => {});
        // Destroy the session: never return a possibly locked connection to a pool.
        client.release(true);
      }
      this.running = false;
    }
  }
}
export function startNotificationScheduler(
  worker: NotificationWorker,
): () => void {
  void worker.run();
  const timer = setInterval(() => void worker.run(), 60_000);
  return () => clearInterval(timer);
}
