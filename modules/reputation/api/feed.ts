import type { Changes, ReputationStore } from "../contract.ts";

type Subscriber = {
  after(): string;
  deliver(delta: Changes): void;
  fail(): void;
};
export type ReputationRouteOptions = {
  maxClients?: number;
  catchupMs?: number;
};
/** Dirty hints share a LISTEN-backed store subscription per active actor.
 * Periodic durable catch-up recovers dropped hints and disconnected listeners.
 */
export class FeedHub {
  private groups = new Map<
    string,
    {
      listeners: Set<Subscriber>;
      timer: ReturnType<typeof setInterval>;
      unsubscribe(): void;
      running: boolean;
      scheduled: boolean;
      dirty: boolean;
      readingAfter: string;
      poll(): void;
    }
  >();
  private clients = 0;
  private store: ReputationStore;
  private maxClients: number;
  private catchupMs: number;
  constructor(store: ReputationStore, options: ReputationRouteOptions) {
    this.store = store;
    this.maxClients = options.maxClients ?? 2048;
    this.catchupMs = options.catchupMs ?? 30000;
    if (
      !Number.isSafeInteger(this.maxClients) ||
      this.maxClients < 1 ||
      this.maxClients > 2048 ||
      !Number.isSafeInteger(this.catchupMs) ||
      this.catchupMs < 1000 ||
      this.catchupMs > 55000
    )
      throw new Error("invalid_reputation_stream_options");
  }
  attach(actor: string, listener: Subscriber): (() => void) | null {
    let group = this.groups.get(actor);
    if (this.clients >= this.maxClients || (group?.listeners.size ?? 0) >= 4)
      return null;
    if (!group) {
      const listeners = new Set<Subscriber>();
      const tick = async () => {
        if (group!.running || !listeners.size) return;
        group!.dirty = false;
        group!.running = true;
        const after = [...listeners]
          .map((l) => l.after())
          .reduce((a, b) => (BigInt(a) < BigInt(b) ? a : b));
        group!.readingAfter = after;
        try {
          const delta = await this.store.changes(actor, after);
          for (const l of listeners) {
            const cursor = l.after();
            const reset =
              !delta.hasMore && BigInt(cursor) > BigInt(delta.nextCursor);
            l.deliver({
              ...delta,
              changes: delta.changes.filter(
                (c) => BigInt(c.revision) > BigInt(cursor),
              ),
              nextCursor:
                reset || BigInt(delta.nextCursor) > BigInt(cursor)
                  ? delta.nextCursor
                  : cursor,
              resetRequired: reset || delta.resetRequired,
            });
          }
          if (delta.hasMore) group!.dirty = true;
        } catch {
          for (const l of [...listeners]) l.fail();
        } finally {
          group!.running = false;
          if (group!.dirty && listeners.size) group!.poll();
        }
      };
      const poll = () => {
        group!.dirty = true;
        if (group!.running || group!.scheduled || !listeners.size) return;
        group!.scheduled = true;
        queueMicrotask(() => {
          group!.scheduled = false;
          void tick();
        });
      };
      group = {
        listeners,
        timer: setInterval(poll, this.catchupMs),
        unsubscribe: () => {},
        running: false,
        scheduled: false,
        dirty: false,
        readingAfter: "0",
        poll,
      };
      this.groups.set(actor, group);
      group.unsubscribe = this.store.onChange?.(actor, poll) ?? (() => {});
    }
    group.listeners.add(listener);
    this.clients++;
    if (!group.running || BigInt(listener.after()) < BigInt(group.readingAfter))
      group.poll();
    return () => {
      if (!group!.listeners.delete(listener)) return;
      this.clients--;
      if (!group!.listeners.size) {
        clearInterval(group!.timer);
        group!.unsubscribe();
        this.groups.delete(actor);
      }
    };
  }
}
