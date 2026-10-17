import {
  Screen,
  Button,
  EmptyState,
  ErrorState,
  Group,
  List,
  Loading,
  RankingRow,
  Tabs,
} from "../../../packages/ui/src/index.ts";
import {
  displayAmount,
  t,
  type Locale,
} from "../../../packages/i18n/src/index.ts";
import type {
  HolderEntry,
  HoldersPage,
  RankingToken,
} from "../../../packages/platform-sdk/src/index.ts";

/** One mounted screen owns its requests; leaving it aborts all pending reads. */
export function mountHolders(
  container: HTMLElement,
  options: {
    locale: Locale;
    viewerFrogId: string | null;
    read(
      token: RankingToken,
      cursor: string | null,
      signal: AbortSignal,
    ): Promise<HoldersPage>;
  },
): () => void {
  let token: RankingToken = "JPEGPE";
  let entries: HolderEntry[] = [];
  let cursor: string | null = null;
  let pending = false;
  let failure: "unavailable" | "ranking_changed" | null = null;
  let request: AbortController | undefined;
  let disposed = false;
  const text = (
    key: Parameters<typeof t>[1],
    values?: Record<string, string>,
  ) => t(options.locale, key, values);
  const tabs = Group();
  const body = Group();
  body.setAttribute("aria-live", "polite");
  container.append(tabs, body);
  const formatter = new Intl.DateTimeFormat(options.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  function render() {
    tabs.replaceChildren(
      Tabs({
        label: text("holders.tokens"),
        selected: token,
        tabs: (["JPEGPE", "TON"] as const).map((id) => ({
          id,
          label: text(`holders.${id}`),
          onSelect: () => {
            if (token === id) return;
            token = id;
            void load(false);
          },
        })),
      }),
    );
    const list = List({
      label: text("holders.title"),
      children: entries.map((entry) =>
        RankingRow({
          rank: new Intl.NumberFormat(options.locale).format(entry.rank),
          frogId: entry.frogId,
          name: entry.frogName,
          amount: text("holders.amount", {
            amount:
              displayAmount(
                { raw: entry.amount, decimals: 9 },
                options.locale,
                0,
                4,
              ) ?? "",
            token: text(`holders.${token}`),
          }),
          asOf: text("holders.asOf", {
            time: formatter.format(new Date(entry.asOf)),
          }),
          ...(entry.stale ||
          Date.now() - Date.parse(entry.asOf) > 6 * 60 * 60 * 1000
            ? { staleLabel: text("holders.stale") }
            : {}),
          ...(entry.frogId === options.viewerFrogId
            ? { viewerLabel: text("holders.you") }
            : {}),
        }),
      ),
    });
    const content: Node[] = entries.length ? [list] : [];
    if (pending) content.push(Loading({ message: text("common.loading") }));
    else if (failure)
      content.push(
        ErrorState({
          message: text(
            failure === "ranking_changed" ? "holders.changed" : "holders.error",
          ),
          retryLabel: text("common.retry"),
          onRetry: () =>
            void load(failure !== "ranking_changed" && entries.length > 0),
        }),
      );
    else if (!entries.length)
      content.push(EmptyState({ message: text("holders.empty") }));
    if (cursor && !failure)
      content.push(
        Button(text("holders.more"), {
          disabled: pending,
          onClick: () => void load(true),
        }),
      );
    body.replaceChildren(...content);
  }
  async function load(more: boolean) {
    request?.abort();
    const current = new AbortController();
    request = current;
    if (!more) {
      entries = [];
      cursor = null;
    }
    pending = true;
    failure = null;
    render();
    try {
      const page = await options.read(
        token,
        more ? cursor : null,
        current.signal,
      );
      if (disposed || request !== current) return;
      entries = more ? [...entries, ...page.entries] : page.entries;
      cursor = page.nextCursor;
    } catch (error) {
      if (disposed || request !== current) return;
      failure =
        error instanceof Error && error.message === "ranking_changed"
          ? "ranking_changed"
          : "unavailable";
    }
    pending = false;
    render();
  }
  void load(false);
  const freshness = setInterval(render, 60_000);
  return () => {
    disposed = true;
    request?.abort();
    clearInterval(freshness);
  };
}

export function showHolders(
  host: HTMLElement,
  options: Parameters<typeof mountHolders>[1],
  actions: Node[],
): () => void {
  const content = Group();
  host.replaceChildren(
    Screen({
      title: t(options.locale, "holders.title"),
      brand: t(options.locale, "shell.brand"),
      actions,
      children: [content],
    }),
  );
  return mountHolders(content, options);
}
