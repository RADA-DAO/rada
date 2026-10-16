/** One entry per screen, sheet or running app. `leave` runs when the entry is removed by Back. */
export type NavEntry = {
  key: string;
  /** Edge gesture may pop this entry. Sheets and running apps own their own surface. */
  edgeBack?: boolean;
  leave?(): void;
  /** True once the entry's surface closed itself but its close event has not arrived yet. */
  stale?(): boolean;
};
type HistoryLike = Pick<History, "pushState" | "replaceState" | "go">;
type WindowLike = Pick<Window, "addEventListener" | "removeEventListener">;
export type Navigation = ReturnType<typeof createNavigation>;

const stateKey = "radaNav";
const mark = (depth: number) => ({ [stateKey]: depth });
const depthOf = (state: unknown): number | null => {
  if (!state || typeof state !== "object" || !(stateKey in state)) return null;
  const depth = (state as Record<string, unknown>)[stateKey];
  return typeof depth === "number" && Number.isInteger(depth) ? depth : null;
};

/**
 * The platform's only back stack, and the only caller of history navigation.
 * Apps and modules never touch `history`; they push entries and call `back()`.
 */
export function createNavigation(
  root: NavEntry,
  env: { history?: HistoryLike; target?: WindowLike } = {},
) {
  const hist =
    env.history ?? (typeof history === "undefined" ? undefined : history);
  const target =
    env.target ?? (typeof window === "undefined" ? undefined : window);
  const stack: NavEntry[] = [root];
  const listeners = new Set<() => void>();
  let guard: (() => boolean) | undefined;
  // Traversals we started ourselves; their popstate events must not pop again.
  let expected = 0;
  let writes: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const flush = () => {
    clearTimeout(timer);
    expected = 0;
    const pending = writes;
    writes = [];
    for (const write of pending) write();
  };
  // A write issued while a traversal is in flight would truncate the wrong entries.
  const write = (action: () => void) => {
    if (expected > 0) writes.push(action);
    else action();
  };
  const traverse = (delta: number) => {
    if (!hist || delta === 0) return;
    expected++;
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
    hist.go(delta);
  };
  /** Remove `stack[start..]`; entries above `start` are left top-down. */
  function cut(start: number, syncHistory: boolean, leaveFirst: boolean) {
    const removed = stack.splice(start).reverse();
    if (syncHistory) traverse(-removed.length);
    for (const [index, entry] of removed.entries())
      if (leaveFirst || index < removed.length - 1) entry.leave?.();
    emit();
  }
  const indexOf = (key: string) => {
    for (let at = stack.length - 1; at >= 0; at--)
      if (stack[at]?.key === key) return at;
    return -1;
  };

  const onPopState = (event: Event) => {
    if (disposed) return;
    if (expected > 0) {
      expected--;
      if (expected === 0) flush();
      return;
    }
    const depth = depthOf((event as PopStateEvent).state);
    if (depth === null) return;
    const current = stack.length - 1;
    if (depth === current) return;
    if (depth < current && depth >= 0 && !guard?.()) {
      cut(depth + 1, false, true);
      return;
    }
    // Forward past the stack, or Back while a write is pending: undo it.
    traverse(current - depth);
  };
  hist?.replaceState(mark(0), "");
  target?.addEventListener("popstate", onPopState);

  return {
    get depth() {
      return stack.length;
    },
    get top(): NavEntry {
      return stack[stack.length - 1] as NavEntry;
    },
    get canGoBack() {
      return stack.length > 1;
    },
    /** Entry directly below the top, for previews of the back destination. */
    get below(): NavEntry | undefined {
      return stack[stack.length - 2];
    },
    get keys(): readonly string[] {
      return stack.map((entry) => entry.key);
    },
    has: (key: string) => indexOf(key) >= 0,
    /** A key already in the stack unwinds to it instead of growing the stack. */
    push(entry: NavEntry) {
      const at = indexOf(entry.key);
      if (at >= 0) {
        if (at < stack.length - 1) cut(at + 1, true, true);
        return;
      }
      stack.push(entry);
      const depth = stack.length - 1;
      write(() => hist?.pushState(mark(depth), ""));
      emit();
    },
    replace(entry: NavEntry) {
      const previous = stack[stack.length - 1];
      stack[stack.length - 1] = entry;
      const depth = stack.length - 1;
      write(() => hist?.replaceState(mark(depth), ""));
      previous?.leave?.();
      emit();
    },
    /** Pop the top entry. Returns true when Back was consumed, including by the guard. */
    back(): boolean {
      if (guard?.()) return true;
      while (stack.length > 1 && stack[stack.length - 1]?.stale?.())
        cut(stack.length - 1, true, false);
      if (stack.length < 2) return false;
      cut(stack.length - 1, true, true);
      return true;
    },
    /** Remove an entry that closed itself (a sheet's own Close button) without calling `leave` for it. */
    drop(key: string) {
      const at = indexOf(key);
      if (at > 0) cut(at, true, false);
    },
    /** While the guard returns true, Back and browser Back are consumed and nothing is popped. */
    setGuard(next: (() => boolean) | undefined) {
      guard = next;
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      target?.removeEventListener("popstate", onPopState);
      listeners.clear();
    },
  };
}
