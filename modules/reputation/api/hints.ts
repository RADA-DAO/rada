import type pg from "pg";

type Connection = {
  client: pg.PoolClient;
  notification: (message: pg.Notification) => void;
  failure: () => void;
};
/** One LISTEN session for this service, irrespective of subscriber count.
 * Hints never carry data to callers. Durable own-subject reads remain authoritative.
 */
export class ReputationHints {
  private pool: pg.Pool;
  private listeners = new Map<string, Set<() => void>>();
  private connection: Connection | null = null;
  private starting: Promise<void> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private retired = new Set<Promise<void>>();
  private epoch = 0;
  private backoff = 250;
  private disposed = false;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  subscribe(subject: string, listener: () => void): () => void {
    if (this.disposed) return () => {};
    let listeners = this.listeners.get(subject);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(subject, listeners);
    }
    listeners.add(listener);
    this.ensure();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      listeners!.delete(listener);
      if (!listeners!.size) this.listeners.delete(subject);
      if (!this.listeners.size) this.stop();
    };
  }
  private wake(listeners: Iterable<() => void>) {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        /* A hint cannot fail committed work. */
      }
    }
  }
  private ensure() {
    if (
      this.disposed ||
      !this.listeners.size ||
      this.connection ||
      this.starting ||
      this.retry
    )
      return;
    const epoch = this.epoch;
    this.starting = this.connect(epoch).finally(() => {
      this.starting = null;
      this.ensure();
    });
  }
  private async connect(epoch: number) {
    try {
      const client = await this.pool.connect();
      if (this.disposed || epoch !== this.epoch || !this.listeners.size) {
        client.release();
        return;
      }
      const connection: Connection = {
        client,
        notification: (message) => {
          if (message.channel !== "reputation_changes" || !message.payload)
            return;
          try {
            const payload: unknown = JSON.parse(message.payload);
            if (
              !payload ||
              typeof payload !== "object" ||
              !("subject" in payload) ||
              typeof payload.subject !== "string"
            )
              return;
            this.wake(this.listeners.get(payload.subject) ?? []);
          } catch {
            /* Malformed hints are ignored; periodic catch-up recovers. */
          }
        },
        failure: () => {
          if (this.connection !== connection) return;
          this.retire(connection, true);
          this.reconnect();
        },
      };
      this.connection = connection;
      client.on("notification", connection.notification);
      client.on("error", connection.failure);
      client.on("end", connection.failure);
      try {
        await client.query("LISTEN reputation_changes");
      } catch {
        connection.failure();
        return;
      }
      if (this.connection !== connection) return;
      this.backoff = 250;
      // Changes between first read and LISTEN registration must be recovered.
      for (const listeners of this.listeners.values()) this.wake(listeners);
    } catch {
      this.reconnect();
    }
  }
  private reconnect() {
    if (this.disposed || !this.listeners.size || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.ensure();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 10000);
  }
  private retire(connection: Connection, destroy: boolean) {
    if (this.connection !== connection) return;
    this.connection = null;
    const { client, notification, failure } = connection;
    client.removeListener("notification", notification);
    client.removeListener("error", failure);
    client.removeListener("end", failure);
    if (destroy) {
      client.release(true);
      return;
    }
    const ignoreRetirementFailure = () => {};
    client.on("error", ignoreRetirementFailure);
    const retired = client
      .query("UNLISTEN reputation_changes")
      .then(
        () => client.release(),
        () => client.release(true),
      )
      .finally(() => {
        client.removeListener("error", ignoreRetirementFailure);
        this.retired.delete(retired);
      });
    this.retired.add(retired);
  }
  private stop() {
    this.epoch++;
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    if (this.connection) this.retire(this.connection, false);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    this.stop();
    await this.starting;
    await Promise.all(this.retired);
  }
}
