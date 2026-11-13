import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
import type { Client } from "./client.ts";
import { changes } from "./model.ts";
type StreamApi = ModuleApi & {
  stream?(
    path: string,
    options: {
      signal?: AbortSignal;
      onEvent(event: { event: string; data: unknown; id: string | null }): void;
    },
  ): Promise<void>;
};
/** Stream data is a hint. Only fresh API reads and receipts paint the screen. */
export function subscribeChanges(
  api: StreamApi,
  client: Client,
  initial: string,
  signal: AbortSignal,
  refresh: () => void,
) {
  const live = () => !signal.aborted;
  let cursor = initial;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function feed() {
    if (!live()) return;
    try {
      const result = await client.changes(cursor);
      if (!live()) return;
      if (result.resetRequired || BigInt(result.nextCursor) >= BigInt(cursor))
        cursor = result.nextCursor;
      if (result.changes.length || result.resetRequired) refresh();
      if (result.hasMore) {
        timer = setTimeout(() => void feed(), 0);
        return;
      }
      if (!api.stream) return;
      await api.stream(`/v1/reputation/stream?after=${cursor}`, {
        signal,
        onEvent: (event) => {
          if (!live() || event.event !== "changes") return;
          try {
            const value = changes(event.data);
            if (
              !value.resetRequired &&
              BigInt(value.nextCursor) < BigInt(cursor)
            )
              return;
            cursor = value.nextCursor;
            failures = 0;
            if (value.changes.length || value.resetRequired) refresh();
          } catch {
            /* Durable feed recovers malformed delivery hints. */
          }
        },
      });
    } catch {
      /* Reconnect through durable changes after transport failure. */
    }
    if (live() && api.stream)
      timer = setTimeout(
        () => void feed(),
        Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)),
      );
  }
  async function fallback() {
    if (!live() || document.hidden) return;
    try {
      let more: boolean;
      do {
        const result = await client.changes(cursor);
        if (!live()) return;
        if (result.resetRequired || BigInt(result.nextCursor) >= BigInt(cursor))
          cursor = result.nextCursor;
        more = result.hasMore;
        if (result.changes.length || result.resetRequired) refresh();
      } while (more && live());
    } catch {
      /* Keep confirmed results visible while offline. */
    }
  }
  void feed();
  const interval = setInterval(() => void fallback(), 15000);
  const stop = () => {
    clearTimeout(timer);
    clearInterval(interval);
  };
  signal.addEventListener("abort", stop, { once: true });
  return stop;
}
