import {
  Button,
  Facts,
  List,
  ListItem,
  Section,
  Text,
} from "../../../packages/ui/src/index.ts";
import { form } from "./forms.ts";
import type { Context } from "./context.ts";
import type { History, Rules, Settings } from "./model.ts";
const keys: (keyof Rules)[] = [
  "who_opens",
  "duration_hours",
  "decision_days",
  "allow_vote_changes",
  "require_membership_at_open",
  "keep_departed_votes",
  "allow_majority_override",
];
export function ruleValue(ctx: Context, value: Rules[keyof Rules]): string {
  if (typeof value === "boolean") return ctx.text(value ? "yes" : "no");
  return typeof value === "number"
    ? new Intl.NumberFormat(ctx.locale).format(value)
    : ctx.text(`ruleValue.${value}`);
}
export function settingsView(
  ctx: Context,
  current: Settings,
  history: History[],
): Node[] {
  const change = Button(ctx.text("changeSettings"), {
    onClick: () => {
      form(ctx, {
        title: ctx.text("changeSettings"),
        path: "/settings",
        opener: change,
        fields: [
          ...keys.map((key) => ({
            key,
            label: ctx.text(`rule.${key}`),
            value: String(current.rules[key]),
            ...(typeof current.rules[key] === "boolean"
              ? {
                  kind: "select" as const,
                  choices: [true, false].map((value) => ({
                    value: String(value),
                    label: ctx.text(value ? "yes" : "no"),
                  })),
                }
              : key === "who_opens"
                ? {
                    kind: "select" as const,
                    choices: ["steward-opens", "author-opens"].map((value) => ({
                      value,
                      label: ctx.text(`ruleValue.${value}`),
                    })),
                  }
                : { required: true, inputMode: "decimal" as const }),
          })),
          {
            key: "reason",
            label: ctx.text("reason"),
            required: true,
            kind: "textarea",
            maxLength: 2000,
          },
        ],
        validate: (v) =>
          Number(v.duration_hours) >= 1 &&
          Number(v.duration_hours) <= 720 &&
          Number(v.decision_days) >= 1 &&
          Number(v.decision_days) <= 365,
        payload: (v) => ({
          reason: v.reason,
          rules: Object.fromEntries(
            keys.map((key) => [
              key,
              typeof current.rules[key] === "boolean"
                ? v[key] === "true"
                : typeof current.rules[key] === "number"
                  ? Number(v[key])
                  : v[key],
            ]),
          ),
        }),
      });
    },
  });
  return [
    Text(ctx.text("futureSettings")),
    ...(ctx.steward ? [change] : []),
    ...keys.map((key) =>
      Section({
        title: ctx.text(`rule.${key}`),
        children: [
          Facts([
            {
              label: ctx.text("currentValue", { version: current.version }),
              value: ruleValue(ctx, current.rules[key]),
            },
          ]),
          List({
            children: history.map((entry) =>
              ListItem({
                title: ctx.text("version", {
                  version: entry.version,
                  value: ruleValue(ctx, entry.rules[key]),
                }),
                description: `${new Date(entry.changed_at).toLocaleString(ctx.locale)} · ${entry.reason}`,
              }),
            ),
          }),
        ],
      }),
    ),
  ];
}
