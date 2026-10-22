import {
  Screen,
  Group,
  Section,
  List,
  Button,
  Tabs,
  Loading,
  EmptyState,
  ErrorState,
} from "../../../packages/ui/src/index.ts";
import { type Locale } from "../../../packages/i18n/src/index.ts";
import type { ModuleApi } from "../../../packages/platform-sdk/src/index.ts";
import "@rada/ui/screens/treasury.css";
import { presentation, type Wallet, type Transaction } from "./presentation.ts";
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
  const { text, styled, summary, wallet, history } = presentation(
    options.locale,
  );
  const content = styled(Group(), "overview"),
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
  const view = Screen({
    title: text("treasury.title"),
    titleHidden: true,
    brand: options.brand,
    actions: options.actions,
    children: [content, activity],
  });
  view.classList.add("rada-treasury-view");
  host.replaceChildren(view);
  function drawWallets() {
    const total = summary(wallets);
    content.replaceChildren(...(total ? [total] : []));
    if (wallets.length)
      content.append(
        styled(
          Section({
            title: text("treasury.locations"),
            children: [
              styled(List({ children: wallets.map(wallet) }), "wallets"),
            ],
          }),
          "locations",
        ),
      );
    else
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
    const controls = document.createElement("details");
    controls.className = "rada-treasury-filters";
    const toggle = document.createElement("summary");
    toggle.textContent = text("treasury.filters");
    controls.append(toggle, filters);
    activity.replaceChildren(
      styled(
        Section({
          title: text("treasury.transactions"),
          children: [
            controls,
            ...(entries.length
              ? history(entries, (id) => {
                  void options.openDecision(id).catch(() => {
                    if (!lifetime.signal.aborted) activity.append(error());
                  });
                })
              : [
                  EmptyState({
                    title: text("treasury.transactions"),
                    message: text("treasury.empty"),
                  }),
                ]),
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
        "history",
      ),
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
    const active = () => current === generation && !lifetime.signal.aborted;
    const overview = more
      ? Promise.resolve()
      : get("/v1/treasury/overview")
          .then((body) => {
            if (!active()) return;
            wallets = (body as { wallets: Wallet[] }).wallets;
            drawWallets();
          })
          .catch(() => {
            if (active()) content.replaceChildren(error());
          });
    try {
      const page = (await get(
        `/v1/treasury/transactions${query.size ? `?${query}` : ""}`,
      )) as {
        transactions: Transaction[];
        nextCursor: string | null;
      };
      if (!active()) return;
      entries = more ? [...entries, ...page.transactions] : page.transactions;
      next = page.nextCursor;
      drawActivity();
    } catch {
      if (current === generation && !lifetime.signal.aborted) {
        activity.replaceChildren(error());
      }
    }
    await overview;
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
