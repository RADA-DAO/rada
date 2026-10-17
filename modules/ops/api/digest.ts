// Hourly failure digest. Disabled unless ALERTS_ENABLED=true plus a chat id.
// Messages carry counts and identifiers only: never message text, frames,
// tokens, URLs or personal data.

export interface DigestGroup {
  label: string;
  total: number;
}

export interface ClientErrorSummary {
  groups: DigestGroup[];
  total: number;
  lastId: number;
}

export interface AlertStore {
  /** Summary of client errors newer than the persisted watermark. */
  summary(): Promise<ClientErrorSummary>;
  advance(lastId: number): Promise<void>;
}

export interface AlertConfig {
  token: string;
  chatId: string;
}

const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const SAFE_LABEL = /[^A-Za-z0-9_.:/-]/g;
const TOP = 3;
const SEND_TIMEOUT_MS = 10_000;
const INTERVAL_MS = 60 * 60 * 1000;

/** Returns a config only when explicitly enabled and fully configured. */
export function alertConfig(
  env: Record<string, string | undefined>,
): AlertConfig | undefined {
  if (env["ALERTS_ENABLED"]?.trim() !== "true") return undefined;
  const chatId = env["ALERT_TELEGRAM_CHAT_ID"]?.trim() ?? "";
  const token = env["TELEGRAM_BOT_TOKEN"]?.trim() ?? "";
  if (!token || !CHAT_ID.test(chatId)) return undefined;
  return { token, chatId };
}

export function safeLabel(value: string): string {
  return value.replace(SAFE_LABEL, "?").slice(0, 80);
}

function section(
  title: string,
  total: number,
  groups: DigestGroup[],
): string[] {
  if (total <= 0) return [];
  const top = [...groups].sort((a, b) => b.total - a.total).slice(0, TOP);
  const lines = [`${title}: ${total}`];
  for (const g of top) lines.push(`  ${g.total} x ${safeLabel(g.label)}`);
  if (groups.length > top.length)
    lines.push(`  (+${groups.length - top.length} more groups)`);
  return lines;
}

export function formatDigest(
  client: { total: number; groups: DigestGroup[] },
  server: { total: number; groups: DigestGroup[] },
): string | undefined {
  const lines = [
    ...section("Client errors", client.total, client.groups),
    ...section("Server failures", server.total, server.groups),
  ];
  if (lines.length === 0) return undefined;
  return ["RADA failure digest (last hour)", ...lines].join("\n");
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DigestDeps {
  config: AlertConfig;
  store?: AlertStore | undefined;
  /** Live per-route failure counters owned by the error reporter. */
  counts: ReadonlyMap<string, number>;
  fetch?: Fetch | undefined;
  log?: ((line: string) => void) | undefined;
}

/** Keeps the server-count baseline in memory; client errors use the database watermark. */
export class FailureDigest {
  #baseline = new Map<string, number>();
  #running = false;
  private readonly deps: DigestDeps;
  constructor(deps: DigestDeps) {
    this.deps = deps;
  }

  /** Runs one digest; resolves to true when a message was sent. Never throws. */
  async run(): Promise<boolean> {
    if (this.#running) return false;
    this.#running = true;
    try {
      return await this.#run();
    } catch (error) {
      this.#fail(error);
      return false;
    } finally {
      this.#running = false;
    }
  }

  async #run(): Promise<boolean> {
    const { store, counts, config } = this.deps;
    const current = new Map(counts);
    const serverGroups: DigestGroup[] = [];
    let serverTotal = 0;
    for (const [route, count] of current) {
      const delta = count - (this.#baseline.get(route) ?? 0);
      if (delta > 0) {
        serverGroups.push({ label: route, total: delta });
        serverTotal += delta;
      }
    }
    const client = store
      ? await store.summary()
      : { groups: [], total: 0, lastId: 0 };
    const text = formatDigest(client, {
      total: serverTotal,
      groups: serverGroups,
    });
    if (text !== undefined) await this.#send(config, text);
    // Advance only after success (or silence), so failures retry next hour.
    this.#baseline = current;
    if (store && client.total > 0) await store.advance(client.lastId);
    return text !== undefined;
  }

  async #send(config: AlertConfig, text: string): Promise<void> {
    const send = this.deps.fetch ?? ((url, init) => fetch(url, init));
    const response = await send(
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.chatId,
          text,
          disable_web_page_preview: true,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );
    if (!response.ok) throw new DigestHttpError(response.status);
  }

  #fail(error: unknown) {
    // Only the error class and an HTTP status: Telegram URLs contain the bot token.
    const name = error instanceof Error ? error.constructor.name : "NonError";
    const record = {
      time: new Date().toISOString(),
      event: "alert_digest_failed",
      errorClass: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
        ? name
        : "UnknownError",
      ...(error instanceof DigestHttpError ? { status: error.status } : {}),
    };
    try {
      (this.deps.log ?? ((line: string) => console.log(line)))(
        JSON.stringify(record),
      );
    } catch {
      // Logging must never throw.
    }
  }
}

class DigestHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("telegram_http_error");
    this.status = status;
  }
}

/** Starts the hourly timer; the first digest runs one interval after start. */
export function startDigestScheduler(
  digest: Pick<FailureDigest, "run">,
  everyMs: number = INTERVAL_MS,
): () => void {
  const id = setInterval(() => void digest.run(), everyMs);
  return () => clearInterval(id);
}
