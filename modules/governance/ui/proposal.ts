import {
  Actions,
  Badge,
  Button,
  Countdown,
  EvidenceLink,
  Facts,
  List,
  ListItem,
  Section,
  Tally,
  Text,
} from "../../../packages/ui/src/index.ts";
import { attachEvidence, decide, form } from "./forms.ts";
import type { Context } from "./context.ts";
import {
  canVote,
  choices,
  status,
  type Mine,
  type Proposal,
  type Vote,
} from "./model.ts";
export function tally(ctx: Context, p: Proposal): HTMLElement {
  return Tally({
    label: ctx.text("tally"),
    items: choices.map((choice) => ({
      label: ctx.text(`choice.${choice}`),
      count: p.tally[choice],
    })),
  });
}
export function timer(
  ctx: Context,
  p: Proposal,
  cleanup: (() => void)[],
): Node[] {
  if (p.state !== "opened" || !p.closes_at) return [];
  const clock = Countdown({
    until: Date.parse(p.closes_at),
    label: ctx.text("timeLeft"),
    format: (ms) =>
      ms > 0
        ? ctx.text("remaining", {
            hours: Math.floor(ms / 3600000),
            minutes: Math.floor((ms % 3600000) / 60000),
          })
        : ctx.text("status.tally"),
    onEnd: () => void ctx.refresh(),
  });
  cleanup.push(() => {
    clock.dispose();
  });
  return [Facts([{ label: ctx.text("timeLeft"), value: clock.element }])];
}
export function proposalView(
  ctx: Context,
  p: Proposal,
  mine: Mine | undefined,
  votes: Vote[],
  cleanup: (() => void)[],
): Node[] {
  const base = `/proposals/${p.proposal_id}`;
  const nodes: Node[] = [
    Badge(ctx.text(`status.${status(p)}`)),
    Text(p.body),
    Text(ctx.text("advisory")),
    ...timer(ctx, p, cleanup),
    Section({ title: ctx.text("tally"), children: [tally(ctx, p)] }),
  ];
  if (mine)
    nodes.push(
      Section({
        title: ctx.text("myVote"),
        children: [
          Text(
            ctx.text(mine.choice ? `choice.${mine.choice}` : "withdrawnVote"),
          ),
          Text(ctx.text("receipt", { receipt: mine.receipt }), {
            breakAnywhere: true,
          }),
        ],
      }),
    );
  if (!ctx.member) nodes.push(Text(ctx.text("eligibility")));
  if (canVote(p, ctx.member, mine))
    nodes.push(
      Actions([
        ...choices.map((choice) => {
          const button = Button(ctx.text(`choice.${choice}`), {
            disabled: mine?.choice === choice,
            onClick: () => {
              form(ctx, {
                title: ctx.text("confirmVote", {
                  choice: ctx.text(`choice.${choice}`),
                }),
                path: `${base}/vote`,
                opener: button,
                fields: [],
                payload: () => ({ choice }),
              });
            },
          });
          return button;
        }),
        ...(mine?.choice && p.rules?.allow_vote_changes
          ? [
              Button(ctx.text("withdrawVote"), {
                onClick: () => {
                  form(ctx, {
                    title: ctx.text("withdrawVote"),
                    path: `${base}/vote`,
                    fields: [],
                    payload: () => ({ choice: null }),
                  });
                },
              }),
            ]
          : []),
      ]),
    );
  else if (mine && p.state === "opened" && !p.rules?.allow_vote_changes)
    nodes.push(Text(ctx.text("voteLocked")));
  if (p.decision)
    nodes.push(
      Section({
        title: ctx.text("decision"),
        children: [
          Badge(ctx.text(`status.${p.decision.outcome}`), { tone: "strong" }),
          Text(p.decision.reason),
        ],
      }),
    );
  if (p.withdrawal_reason) nodes.push(Text(p.withdrawal_reason));
  if (p.evidence.length)
    nodes.push(
      Section({
        title: ctx.text("evidence"),
        children: [
          Text(ctx.text("evidenceNote")),
          List({
            children: p.evidence.map((e) =>
              ListItem({
                description: e.body,
                children: [
                  ...(e.link
                    ? [EvidenceLink({ label: ctx.text("link"), href: e.link })]
                    : []),
                  ...(e.tx_hash
                    ? [
                        Text(ctx.text("transaction", { hash: e.tx_hash }), {
                          breakAnywhere: true,
                        }),
                      ]
                    : []),
                ],
              }),
            ),
          }),
        ],
      }),
    );
  if (ctx.steward) {
    const actions: Node[] = [];
    if (p.state === "created")
      actions.push(
        Button(ctx.text("openVoting"), {
          onClick: () => {
            form(ctx, {
              title: ctx.text("openVoting"),
              path: `${base}/open`,
              fields: [],
              payload: () => ({}),
            });
          },
        }),
      );
    if (p.state === "closed" && !p.decision) {
      const button = Button(ctx.text("decide"), {
        onClick: () => {
          decide(ctx, p.proposal_id, button);
        },
      });
      actions.push(button);
    }
    if (p.decision?.outcome === "accept") {
      const button = Button(ctx.text("attachEvidence"), {
        onClick: () => {
          attachEvidence(ctx, p.proposal_id, button);
        },
      });
      actions.push(button);
    }
    if (actions.length)
      nodes.push(
        Section({ title: ctx.text("steward"), children: [Actions(actions)] }),
      );
  }
  nodes.push(
    Section({
      title: ctx.text("votes"),
      children: [
        Text(ctx.text("privacy")),
        List({
          children: votes.map((v) =>
            ListItem({
              title: v.voter?.username ?? ctx.text("anonymous"),
              children: [
                Text(ctx.text("receipt", { receipt: v.receipt }), {
                  breakAnywhere: true,
                }),
                Badge(
                  ctx.text(v.choice ? `choice.${v.choice}` : "withdrawnVote"),
                ),
                ...(!v.current ? [Badge(ctx.text("superseded"))] : []),
                ...(v.excluded ? [Badge(ctx.text("excluded"))] : []),
              ],
            }),
          ),
        }),
      ],
    }),
  );
  return nodes;
}
