import {
  Screen,
  Group,
  Text,
  Section,
  Facts,
  List,
  ListItem,
  TransactionRow,
  Button,
  Tabs,
  Loading,
  EmptyState,
  ErrorState,
  Badge,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  displayAmount,
  type Locale,
} from "../../../packages/i18n/src/index.ts";
import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
type Person = { name: string; frogId: string } | null;
type Wallet = {
  address: string;
  balances: { TON: string; JPEGPE: string } | null;
  asOf: string | null;
  stale: boolean;
  historyStale: boolean;
  indexedThrough: string | null;
  signers: Person[] | null;
  signersAsOf: string | null;
  signersStale: boolean;
};
type Transaction = {
  id: string;
  at: string;
  direction: "in" | "out";
  token: "TON" | "JPEGPE";
  amount: string;
  person: Person;
  decisions: { proposalId: string; evidenceId: string; title: string }[];
};
export function showTreasury(
  host: HTMLElement,
  options: {
    locale: Locale;
    api: ModuleApi;
    authenticated: boolean;
    brand: string;
    actions: Node[];
    openDecision(id: string): Promise<void>;
  },
) {
  const text = (
    key: Parameters<typeof t>[1],
    values: Record<string, string> = {},
  ) => t(options.locale, key, values);
  const content = Group(),
    filters = Group(),
    activity = Group();
  const lifetime = new AbortController();
  let request: AbortController | undefined;
  let token = "",
    direction = "",
    next: string | null = null,
    entries: Transaction[] = [],
    wallets: Wallet[] = [];
  let generation = 0;
  const time = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(options.locale, {
          dateStyle: "medium",
          timeStyle: "short",
        }).format(new Date(value))
      : text("treasury.unknown");
  const amount = (raw: string, token: string) =>
    `${displayAmount({ raw, decimals: 9 }, options.locale, 0, 9) ?? text("treasury.unknown")} ${token}`;
  host.replaceChildren(
    Screen({
      title: text("treasury.title"),
      brand: options.brand,
      actions: options.actions,
      children: [Text(text("treasury.readOnly")), content, filters, activity],
    }),
  );
  function drawWallets() {
    content.replaceChildren(
      ...wallets.map((w) =>
        Section({
          title: text("treasury.balances"),
          children: [
            Text(w.address, { breakAnywhere: true }),
            Facts(
              (["TON", "JPEGPE"] as const).map((token) => ({
                label: text(`treasury.${token}`),
                value: w.balances
                  ? amount(w.balances[token], token)
                  : text("treasury.unknown"),
              })),
            ),
            Text(text("treasury.asOf", { time: time(w.asOf) })),
            ...(w.stale
              ? [Badge(text("treasury.stale"), { tone: "strong" })]
              : []),
            Text(text("treasury.history", { time: time(w.indexedThrough) })),
            ...(w.historyStale
              ? [Badge(text("treasury.incomplete"), { tone: "strong" })]
              : []),
            Section({
              title: text("treasury.signers"),
              children: [
                Text(text("treasury.asOf", { time: time(w.signersAsOf) })),
                ...(w.signersStale ? [Badge(text("treasury.stale"))] : []),
                w.signers === null
                  ? Text(text("treasury.unknown"))
                  : List({
                      children: w.signers.map((p) =>
                        ListItem({
                          title: p?.name ?? text("treasury.anonymous"),
                        }),
                      ),
                    }),
              ],
            }),
          ],
        }),
      ),
    );
    if (!wallets.length)
      content.append(
        EmptyState({
          title: text("treasury.title"),
          message: text("treasury.unconfigured"),
        }),
      );
  }
  function drawFilters() {
    filters.replaceChildren(
      Tabs({
        label: text("treasury.direction"),
        selected: direction,
        tabs: ["", "in", "out"].map((id) => ({
          id,
          label: text(
            id === "in"
              ? "treasury.incoming"
              : id === "out"
                ? "treasury.outgoing"
                : "treasury.all",
          ),
          onSelect: () => {
            direction = id;
            void load(false);
          },
        })),
      }),
      Tabs({
        label: text("treasury.token"),
        selected: token,
        tabs: (["", "TON", "JPEGPE"] as const).map((id) => ({
          id,
          label: text(id ? `treasury.${id}` : "treasury.all"),
          onSelect: () => {
            token = id;
            void load(false);
          },
        })),
      }),
      Button(text("treasury.refresh"), {
        onClick: () => {
          void load(false);
        },
      }),
    );
  }
  function drawActivity() {
    activity.replaceChildren(
      Section({
        title: text("treasury.transactions"),
        children: [
          entries.length
            ? List({
                children: entries.map((e) =>
                  TransactionRow({
                    name: e.person?.name ?? text("treasury.anonymous"),
                    direction: text(
                      e.direction === "in"
                        ? "treasury.incoming"
                        : "treasury.outgoing",
                    ),
                    amount: amount(e.amount, e.token),
                    time: time(e.at),
                    actions: e.decisions.map((d) =>
                      Button(text("treasury.decision", { title: d.title }), {
                        variant: "ghost",
                        onClick: () => {
                          void options.openDecision(d.proposalId).catch(() => {
                            if (!lifetime.signal.aborted)
                              activity.append(error());
                          });
                        },
                      }),
                    ),
                  }),
                ),
              })
            : EmptyState({
                title: text("treasury.transactions"),
                message: text("treasury.empty"),
              }),
          ...(next
            ? [
                Button(text("treasury.more"), {
                  onClick: () => {
                    void load(true);
                  },
                }),
              ]
            : []),
        ],
      }),
    );
  }
  const error = () =>
    ErrorState({
      message: text("treasury.error"),
      retryLabel: text("treasury.retry"),
      onRetry: () => {
        void load(false);
      },
    });
  async function load(more: boolean) {
    request?.abort();
    request = new AbortController();
    const current = ++generation,
      signal = request.signal;
    const get = async (path: string) => {
      const r = await options.api.request("GET", path, {
        auth: options.authenticated,
        signal,
      });
      if (r.status !== 200) throw new Error("unavailable");
      return r.body;
    };
    drawFilters();
    if (!more) {
      entries = [];
      next = null;
      content.replaceChildren(Loading({ message: text("treasury.loading") }));
    }
    activity.replaceChildren(Loading({ message: text("treasury.loading") }));
    const query = new URLSearchParams();
    if (direction) query.set("direction", direction);
    if (token) query.set("token", token);
    if (more && next) query.set("before", next);
    try {
      const [overview, page] = (await Promise.all([
        more ? Promise.resolve({ wallets }) : get("/v1/treasury/overview"),
        get(`/v1/treasury/transactions${query.size ? `?${query}` : ""}`),
      ])) as [
        { wallets: Wallet[] },
        { transactions: Transaction[]; nextCursor: string | null },
      ];
      if (current !== generation || lifetime.signal.aborted) return;
      wallets = overview.wallets;
      entries = more ? [...entries, ...page.transactions] : page.transactions;
      next = page.nextCursor;
      drawWallets();
      drawActivity();
    } catch {
      if (current === generation && !lifetime.signal.aborted) {
        if (!more) content.replaceChildren();
        activity.replaceChildren(error());
      }
    }
  }
  void load(false);
  const interval = setInterval(() => {
    if (!document.hidden) void load(false);
  }, 300_000);
  return () => {
    lifetime.abort();
    request?.abort();
    clearInterval(interval);
    generation++;
  };
}
