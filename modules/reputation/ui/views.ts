import {
  Actions,
  Badge,
  Button,
  Card,
  EmptyState,
  EvidenceLink,
  Facts,
  Group,
  List,
  ListItem,
  Section,
  Tabs,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { Locale } from "../../../packages/i18n/src/index.ts";
import type {
  Appeal,
  Mission,
  Period,
  ReputationItem,
  Summary,
} from "../contract.ts";
import type { Translator } from "./forms.ts";
type Context = {
  text: Translator;
  locale: Locale;
  points(value: string): string;
};
export function summaryView(ctx: Context, value: Summary) {
  const total = Text(ctx.points(value.totalPoints));
  total.classList.add("rada-reputation-total");
  return Group([
    Text(ctx.text(`period.${value.period}`)),
    total,
    Text(ctx.text("lifetime", { points: value.lifetimePoints })),
    ...(value.pendingCount
      ? [Text(ctx.text("pendingCount", { count: value.pendingCount }))]
      : []),
  ]);
}
export function taskView(
  ctx: Context,
  missions: Mission[],
  add: HTMLButtonElement,
  options: {
    busy: Set<string>;
    retry(id: string): boolean;
    verify(mission: Mission, button: HTMLButtonElement): void;
  },
) {
  return [
    Actions([add]),
    ...(missions.length
      ? [
          Section({
            title: ctx.text("available"),
            children: [
              Group(
                missions.map((mission) => {
                  const working = options.busy.has(mission.id);
                  const action = Button(
                    ctx.text(
                      working
                        ? "checking"
                        : options.retry(mission.id)
                          ? "retry"
                          : mission.status === "completed"
                            ? "completed"
                            : mission.status === "checking"
                              ? "checking"
                              : mission.verifier === "acknowledgement"
                                ? "acknowledge"
                                : "verify",
                    ),
                    {
                      variant: "primary",
                      disabled: working || mission.status !== "available",
                      onClick: () => {
                        options.verify(mission, action);
                      },
                    },
                  );
                  action.dataset.focusKey = `mission:${mission.id}`;
                  const tile = Card({
                    label: mission.title,
                    children: [
                      Section({
                        title: mission.title,
                        children: [
                          Text(mission.description),
                          Text(ctx.points(mission.points)),
                          ...(mission.verifier === "acknowledgement"
                            ? [Text(ctx.text("acknowledgementHint"))]
                            : []),
                          ...(mission.actionUrl
                            ? [
                                EvidenceLink({
                                  label: ctx.text("action"),
                                  href: mission.actionUrl,
                                }),
                              ]
                            : []),
                          Actions([action]),
                        ],
                      }),
                    ],
                  });
                  tile.classList.add("rada-reputation-task");
                  tile.dataset.status = working ? "checking" : mission.status;
                  return tile;
                }),
              ),
            ],
          }),
        ]
      : [
          EmptyState({
            title: ctx.text("empty.tasks"),
            message: ctx.text("empty.tasksHint"),
          }),
        ]),
  ];
}
export function historyView(
  ctx: Context,
  items: ReputationItem[],
  period: Period,
  selectPeriod: (period: Period) => void,
  selectItem: (id: string) => void,
) {
  return [
    Tabs({
      label: ctx.text("period.label"),
      selected: period,
      tabs: (["today", "week", "previous_week", "all"] as const).map((id) => ({
        id,
        label: ctx.text(`period.${id}`),
        onSelect: () => {
          selectPeriod(id);
        },
      })),
    }),
    ...(items.length
      ? [
          List({
            label: ctx.text("history"),
            children: items.map((entry) => {
              const button = Button(
                ctx.text("item.row", {
                  title: entry.title,
                  points: entry.points,
                }),
                {
                  variant: "ghost",
                  onClick: () => {
                    selectItem(entry.id);
                  },
                },
              );
              button.dataset.focusKey = `item:${entry.id}`;
              return ListItem({
                children: [
                  button,
                  Badge(ctx.text(`status.${entry.status}`)),
                  Text(
                    new Date(entry.occurredAt).toLocaleString(ctx.locale, {
                      timeZone: "Europe/Kyiv",
                    }),
                  ),
                ],
              });
            }),
          }),
        ]
      : [
          EmptyState({
            title: ctx.text("empty.history"),
            message: ctx.text("empty.historyHint"),
          }),
        ]),
  ];
}
export function itemView(
  ctx: Context,
  detail: ReputationItem,
  appeals: Appeal[],
  appeal: HTMLButtonElement,
) {
  return [
    Section({
      title: detail.title,
      children: [
        Badge(ctx.text(`status.${detail.status}`)),
        Text(ctx.points(detail.points)),
        Text(
          [
            "signed_acknowledgement",
            "trusted_external_evidence",
            "awaiting_interpretation",
            "awaiting_trusted_evidence",
          ].includes(detail.reason)
            ? ctx.text(`reason.${detail.reason}`)
            : detail.reason,
        ),
        Facts([
          {
            label: ctx.text("item.category"),
            value: ctx.text(`category.${detail.category}`),
          },
          {
            label: ctx.text("item.occurred"),
            value: new Date(detail.occurredAt).toLocaleString(ctx.locale, {
              timeZone: "Europe/Kyiv",
            }),
          },
          {
            label: ctx.text("item.recorded"),
            value: new Date(detail.recordedAt).toLocaleString(ctx.locale, {
              timeZone: "Europe/Kyiv",
            }),
          },
        ]),
        Text(ctx.text("item.timezone")),
        ...detail.evidence.map((entry) =>
          entry.url
            ? EvidenceLink({ label: entry.label, href: entry.url })
            : Text(entry.label),
        ),
        appeal,
      ],
    }),
    Section({
      title: ctx.text("appeal.history"),
      children: appeals.length
        ? appeals.map((entry) =>
            Group([
              Badge(
                ctx.text(
                  entry.status === "open"
                    ? "appeal.statusOpen"
                    : "appeal.resolved",
                ),
              ),
              Text(entry.message),
              ...(entry.resolution ? [Text(entry.resolution)] : []),
            ]),
          )
        : [Text(ctx.text("appeal.empty"))],
    }),
  ];
}

/** Keep keyboard focus on the same contribution across confirmed refreshes. */
export function replaceContent(
  target: HTMLElement,
  children: Node[],
  fallback: HTMLElement,
) {
  const focused = document.activeElement;
  const key =
    focused instanceof HTMLElement && target.contains(focused)
      ? focused.dataset.focusKey
      : undefined;
  target.replaceChildren(...children);
  if (key)
    (
      Array.from(target.querySelectorAll<HTMLElement>("[data-focus-key]")).find(
        (node) =>
          node.dataset.focusKey === key &&
          !(node instanceof HTMLButtonElement && node.disabled),
      ) ?? fallback.querySelector<HTMLElement>("h1")
    )?.focus({ preventScroll: true });
}
