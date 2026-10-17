import {
  Badge,
  Button,
  ErrorState,
  Group,
  List,
  ListItem,
  Loading,
  Screen,
  Tabs,
  Text,
  Section,
  isSheetOpen,
} from "../../../packages/ui/src/index.ts";
import type { Locale } from "../../../packages/i18n/src/index.ts";
import type {
  ModuleApi,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import { governanceClient } from "./client.ts";
import { translator, errorText, type Context } from "./context.ts";
import { createProposal } from "./forms.ts";
import {
  inTab,
  status,
  type History,
  type Mine,
  type Proposal,
  type Settings,
  type Tab,
  type Vote,
} from "./model.ts";
import { proposalView, tally, timer } from "./proposal.ts";
import { settingsView } from "./settings.ts";
import type { GovernanceRoute } from "./index.ts";
export function createGovernance(options: {
  api: ModuleApi;
  navigation: Navigation;
  locale(): Locale;
  authenticated: boolean;
  membership(): string;
}) {
  let selected: string | undefined;
  let tab: Tab = "open";
  let dispose: (() => void) | undefined;
  const open = (key: GovernanceRoute) => {
    options.navigation.push({ key, edgeBack: true });
  };
  return {
    selectProposal: (id: string) => {
      selected = id;
      open("governance-proposal");
    },
    open: () => {
      open("governance");
    },
    dispose: () => {
      dispose?.();
      dispose = undefined;
    },
    render(
      host: HTMLElement,
      route: GovernanceRoute,
      frame: { brand: string; actions: Node[] },
    ) {
      const lifecycle = new AbortController();
      const client = governanceClient(
        options.api,
        lifecycle.signal,
        options.authenticated,
      );
      const content = Group();
      const title = Group();
      host.replaceChildren(
        Screen({
          title: translator(options.locale())("title"),
          ...frame,
          children: [title, content],
        }),
      );
      let cleanups: (() => void)[] = [];
      let loading = false;
      let reload = false;
      let generation = 0;
      let proposals: Proposal[] = [];
      let votes: Vote[] = [];
      let more = false;
      let voteMore = false;
      const ctx: Context = {
        text: translator(options.locale()),
        locale: options.locale(),
        client,
        navigation: options.navigation,
        signal: lifecycle.signal,
        member: options.authenticated && options.membership() === "member",
        steward: false,
        refresh: () => load(),
      };
      function clearTimers() {
        cleanups.forEach((stop) => {
          stop();
        });
        cleanups = [];
      }
      function error(error: unknown) {
        content.replaceChildren(
          ErrorState({
            message: errorText(ctx, error),
            retryLabel: ctx.text("retry"),
            onRetry: () => void load(),
          }),
        );
      }
      async function readVotes(cursor?: string) {
        const minimum = cursor ? 100 : Math.max(100, votes.length);
        const items: Vote[] = [];
        let page: Vote[];
        do {
          page = await client.read<Vote[]>(
            `/proposals/${selected ?? ""}/votes${cursor ? `?after=${cursor}` : ""}`,
            "votes",
          );
          items.push(...page);
          cursor = page.at(-1)?.vote_id;
        } while (page.length === 100 && items.length < minimum);
        return { items, more: page.length === 100 };
      }
      async function load(append = false) {
        if (lifecycle.signal.aborted) return;
        if (loading) {
          reload = true;
          return;
        }
        loading = true;
        const id = ++generation;
        const stale = () => lifecycle.signal.aborted || generation !== id;
        try {
          if (options.authenticated) {
            const viewer = await client.read<{ steward: boolean }>(
              "/viewer",
              "viewer",
              true,
            );
            ctx.steward = viewer.steward;
          }
          if (route === "governance-settings") {
            const [current, history] = await Promise.all([
              client.read<Settings>("/settings", "settings"),
              client.read<History[]>("/settings/history", "history"),
            ]);
            if (!stale())
              content.replaceChildren(...settingsView(ctx, current, history));
          } else if (route === "governance-proposal" && selected) {
            const cursor = append ? votes.at(-1)?.vote_id : undefined;
            const [p, nextVotes, mine] = await Promise.all([
              client.read<Proposal>(`/proposals/${selected}`, "proposal"),
              readVotes(cursor),
              options.authenticated
                ? client.read<Mine[]>("/votes/mine", "votes", true)
                : Promise.resolve([]),
            ]);
            if (stale()) return;
            votes = append ? [...votes, ...nextVotes.items] : nextVotes.items;
            voteMore = nextVotes.more;
            title.replaceChildren(Section({ title: p.title }));
            clearTimers();
            content.replaceChildren(
              ...proposalView(
                ctx,
                p,
                mine.find((v) => v.proposal_id === selected),
                votes,
                cleanups,
              ),
            );
            if (voteMore)
              content.append(
                Button(ctx.text("moreVotes"), {
                  onClick: () => void load(true),
                }),
              );
          } else {
            const cursor = append ? proposals.at(-1)?.proposal_id : undefined;
            const page = await client.read<Proposal[]>(
              `/proposals${cursor ? `?before=${cursor}` : ""}`,
              "proposals",
            );
            if (stale()) return;
            proposals = append ? [...proposals, ...page] : page;
            more = page.length === 50;
            drawList();
          }
        } catch (e) {
          if (!stale()) error(e);
        } finally {
          loading = false;
          if (reload) {
            reload = false;
            void load();
          }
        }
      }
      function drawList() {
        clearTimers();
        const create = Button(ctx.text("create"), {
          onClick: () => {
            createProposal(ctx, create);
          },
        });
        const shown = proposals.filter((p) => inTab(p, tab));
        content.replaceChildren(
          Text(ctx.text("advisory")),
          ...(ctx.member ? [create] : [Text(ctx.text("eligibility"))]),
          Button(ctx.text("settings"), {
            variant: "ghost",
            onClick: () => {
              open("governance-settings");
            },
          }),
          Tabs({
            label: ctx.text("proposals"),
            selected: tab,
            tabs: (["open", "closed", "decided"] as const).map((id) => ({
              id,
              label: ctx.text(`tab.${id}`),
              onSelect: () => {
                tab = id;
                drawList();
              },
            })),
          }),
          List({
            label: ctx.text("proposals"),
            children: shown.map((p) =>
              ListItem({
                children: [
                  Button(p.title, {
                    variant: "ghost",
                    onClick: () => {
                      selected = p.proposal_id;
                      open("governance-proposal");
                    },
                  }),
                  Badge(ctx.text(`status.${status(p)}`)),
                  ...timer(ctx, p, cleanups),
                  tally(ctx, p),
                ],
              }),
            ),
          }),
          ...(shown.length ? [] : [Text(ctx.text("empty"))]),
          ...(more
            ? [Button(ctx.text("more"), { onClick: () => void load(true) })]
            : []),
        );
      }
      content.replaceChildren(Loading({ message: ctx.text("loading") }));
      void load();
      const interval = setInterval(() => {
        if (
          !isSheetOpen() &&
          !document.hidden &&
          route === "governance-proposal"
        )
          void load();
      }, 15000);
      dispose = () => {
        lifecycle.abort();
        clearInterval(interval);
        clearTimers();
        generation++;
      };
    },
  };
}

export type { Choice, Proposal, Rules } from "./model.ts";
