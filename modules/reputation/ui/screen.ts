import "@rada/ui/screens/reputation.css";
import {
  Button,
  EmptyState,
  ErrorState,
  Group,
  Loading,
  Screen,
  Tabs,
  Text,
} from "../../../packages/ui/src/index.ts";
import { t, type MessageKey } from "../../../packages/i18n/src/index.ts";
import type { ReputationOptions } from "./context.ts";
import type {
  Appeal,
  AppealInput,
  CommandResult,
  Mission,
  Period,
  ReportInput,
  ReputationItem,
  Summary,
} from "../contract.ts";
import { reputationClient } from "./client.ts";
import {
  appealForm,
  reportForm,
  type Draft,
  type Translator,
} from "./forms.ts";
import { ReadGuard, ReputationError, receiptIsCurrent } from "./model.ts";
import { recoveryStore } from "./recovery.ts";
import {
  summaryView,
  taskView,
  historyView,
  itemView,
  replaceContent,
} from "./views.ts";
import { commandActions, type Pending } from "./commands.ts";
import { subscribeChanges } from "./updates.ts";
import type { ReputationRoute } from "./index.ts";

export function createReputation(options: ReputationOptions) {
  let selected: string | undefined;
  let period: Period = "today";
  let stop: (() => void) | undefined;
  let actor = options.actorKey?.() ?? null;
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    /* Storage may be restricted by the host. */
  }
  let recovery = recoveryStore(actor, storage);
  const pending = new Map<string, Pending>();
  const report: Draft<ReportInput> = { attempted: false };
  const appeals = new Map<string, Draft<AppealInput>>();
  const open = (route: ReputationRoute = "tasks") => {
    options.navigation.push({ key: route, edgeBack: true });
  };
  const selectItem = (id: string) => {
    selected = id;
    open("reputation-item");
  };
  return {
    open,
    selectItem,
    dispose() {
      stop?.();
      stop = undefined;
    },
    render(
      host: HTMLElement,
      route: ReputationRoute,
      frame: { brand: string; actions: Node[] },
    ) {
      stop?.();
      const identity = options.actorKey?.() ?? null;
      if (identity !== actor) {
        selected = undefined;
        pending.clear();
        appeals.clear();
        delete report.body;
        delete report.requestId;
        report.attempted = false;
        actor = identity;
        recovery = recoveryStore(actor, storage);
      }
      for (const entry of recovery.list()) {
        if (entry.kind === "verify" && !pending.has(entry.missionId))
          pending.set(entry.missionId, {
            body: {
              requestId: entry.requestId,
              missionVersion: entry.missionVersion,
            },
            attempted: true,
          });
      }
      const lifecycle = new AbortController();
      const signal = lifecycle.signal;
      const client = reputationClient(options.api, signal);
      const locale = options.locale();
      const text: Translator = (key, values) =>
        t(locale, `reputation.${key}` as MessageKey, values);
      const active = () =>
        !signal.aborted && (options.actorKey?.() ?? null) === identity;
      const content = Group();
      const notice = Text("", { live: "polite" });
      const summaryHost = Group();
      const main = Group();
      content.classList.add("rada-reputation-workspace");
      content.append(notice, summaryHost, main);
      const view = Screen({
        ...frame,
        title: text(
          route === "tasks"
            ? "tasks"
            : route === "reputation"
              ? "title"
              : "item.title",
        ),
        children: [content],
      });
      view.classList.add("rada-reputation-view");
      host.replaceChildren(view);
      const guard = new ReadGuard();
      let current: Summary | undefined;
      let missions: Mission[] = [];
      let items: ReputationItem[] = [];
      let detail: ReputationItem | undefined;
      let appealList: Appeal[] = [];
      let cursor: string | null = null;
      let streamStarted = false;
      let stopUpdates: (() => void) | undefined;
      let loadingMore = false;
      const busy = new Set<string>();
      function errorText(error: unknown) {
        const status = error instanceof ReputationError ? error.status : 0;
        return text(
          `error.${String([400, 401, 403, 404, 409, 429, 503].includes(status) ? status : 0)}`,
        );
      }
      const ctx = {
        text,
        navigation: options.navigation,
        signal,
        error: errorText,
      };
      const commands = commandActions(client, recovery, pending, {
        text,
        active,
        receipt,
        notice: (message) => {
          notice.textContent = message;
        },
        error: errorText,
        draw,
        reportRecovered: () => {
          delete report.body;
          report.attempted = false;
          delete report.requestId;
        },
        reportMissing: (id) => {
          report.requestId = id;
          report.attempted = false;
          draw();
        },
        busy,
      });
      const replace = (target: HTMLElement, children: Node[]) => {
        replaceContent(target, children, view);
      };
      function points(value: string) {
        return text("points", {
          points: value.replace(".", locale === "uk" ? "," : "."),
        });
      }
      function drawSummary(value: Summary) {
        if (current && BigInt(value.revision) < BigInt(current.revision))
          return;
        current = value;
        replace(summaryHost, [summaryView({ text, locale, points }, value)]);
        summaryHost.classList.add("rada-reputation-summary");
      }
      function draw() {
        if (!active()) return;
        const navigation = Tabs({
          label: text("navigation"),
          selected: route === "tasks" ? "tasks" : "reputation",
          tabs: (["tasks", "reputation"] as const).map((id) => ({
            id,
            label: text(id === "tasks" ? "tasks" : "title"),
            onSelect: () => {
              open(id);
            },
          })),
        });
        if (route === "tasks") {
          const lostReport = recovery
            .list()
            .find((entry) => entry.kind === "report");
          const add = Button(
            text(
              lostReport && !report.body && !report.requestId
                ? "recover"
                : "report.open",
            ),
            {
              onClick: () => {
                if (lostReport && !report.body && !report.requestId) {
                  void commands.recoverCommands();
                  return;
                }
                reportForm(ctx, add, report, (body, recover) =>
                  commands.report(body, recover),
                );
              },
            },
          );
          add.dataset.focusKey = "report";
          replace(main, [
            navigation,
            ...taskView({ text, locale, points }, missions, add, {
              busy,
              retry: (id) => pending.has(id),
              verify: (mission, button) => {
                guard.invalidate();
                void commands.verify(mission, button);
              },
            }),
            ...moreButton(),
          ]);
        } else if (route === "reputation") {
          replace(main, [
            navigation,
            ...historyView(
              { text, locale, points },
              items,
              period,
              (next) => {
                period = next;
                void load();
              },
              selectItem,
            ),
            ...moreButton(),
          ]);
        } else if (detail) {
          const detailId = detail.id;
          const appeal = Button(text("appeal.open"), {
            onClick: () => {
              const draft = appeals.get(detailId) ?? { attempted: false };
              appeals.set(detailId, draft);
              appealForm(ctx, appeal, draft, async (body) => {
                const result = await client.appeal(detailId, body);
                if (!active()) return;
                appealList = [
                  result,
                  ...appealList.filter((entry) => entry.id !== result.id),
                ];
                appeals.delete(detailId);
                notice.textContent = text("appeal.saved");
                draw();
              });
            },
          });
          appeal.dataset.focusKey = `appeal:${detail.id}`;
          replace(
            main,
            itemView({ text, locale, points }, detail, appealList, appeal),
          );
        }
      }
      function moreButton(): Node[] {
        return cursor
          ? [
              Button(text("more"), {
                disabled: loadingMore,
                onClick: () => void load(true),
              }),
            ]
          : [];
      }
      function receipt(result: CommandResult) {
        guard.receipt(result.summary);
        if (
          receiptIsCurrent(result.summary, current) &&
          (!current ||
            BigInt(result.summary.revision) >= BigInt(current.revision))
        ) {
          if (result.summary.period === (route === "tasks" ? "today" : period))
            drawSummary(result.summary);
          missions = missions.map((mission) =>
            mission.id === result.item.missionId
              ? {
                  ...mission,
                  status:
                    result.state === "completed" ? "completed" : "checking",
                }
              : mission,
          );
          items = [
            result.item,
            ...items.filter((entry) => entry.id !== result.item.id),
          ];
        }
        notice.textContent = text(
          result.state === "completed" ? "confirmed" : "pending",
        );
        draw();
        void load();
      }
      async function load(append = false) {
        if (!active()) return;
        const ticket = guard.begin();
        const requestedPeriod = route === "tasks" ? "today" : period;
        loadingMore = append;
        try {
          const [value, data, history] = await Promise.all([
            client.summary(requestedPeriod),
            route === "tasks"
              ? client.missions(append ? cursor : null)
              : route === "reputation"
                ? client.items(requestedPeriod, append ? cursor : null)
                : selected
                  ? client.item(selected)
                  : Promise.reject(new ReputationError(404)),
            route === "reputation-item" && selected
              ? client.appeals(selected)
              : Promise.resolve([]),
          ]);
          if (!active() || !guard.accept(ticket, value)) return;
          drawSummary(value);
          if (route === "tasks" && "items" in data) {
            missions = append
              ? [...missions, ...(data.items as Mission[])]
              : (data.items as Mission[]);
            cursor = data.nextCursor;
          } else if (route === "reputation" && "items" in data) {
            items = append
              ? [...items, ...(data.items as ReputationItem[])]
              : (data.items as ReputationItem[]);
            cursor = data.nextCursor;
          } else if ("id" in data) {
            detail = data;
            appealList = history;
          }
          draw();
          if (!streamStarted) {
            streamStarted = true;
            void commands.recoverCommands();
            stopUpdates = subscribeChanges(
              options.api,
              client,
              value.revision,
              signal,
              () => {
                void load();
              },
            );
          }
        } catch (error) {
          if (
            active() &&
            guard.accept(ticket, current ?? ({ revision: "0" } as Summary))
          )
            replace(main, [
              ErrorState({
                message: errorText(error),
                retryLabel: text("retry"),
                onRetry: () => void load(),
              }),
            ]);
        } finally {
          loadingMore = false;
        }
      }
      stop = () => {
        lifecycle.abort();
        guard.invalidate();
        stopUpdates?.();
      };
      if (options.authenticated && options.actorKey && !identity) {
        main.replaceChildren(Loading({ message: text("loading") }));
        return;
      }
      if (!options.authenticated) {
        main.replaceChildren(
          EmptyState({ title: text("signIn"), message: text("signInHint") }),
        );
        return;
      }
      main.replaceChildren(Loading({ message: text("loading") }));
      void load();
    },
  };
}
