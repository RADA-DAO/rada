import type { MessageKey } from "../../../packages/i18n/src/index.ts";
import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Facts,
  Group,
  List,
  ListItem,
  LiveRegion,
  Picture,
  Section,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { Claim, OwnBid } from "./api.ts";
import { openClaimSheet } from "./claim.ts";
import { loadInto, type SplashContext } from "./context.ts";
import { clock, jpegpe, utcMoment } from "./format.ts";

/** The honest label for a win: unknown payments are never shown as paid. */
function claimBadge(claim: Claim): MessageKey {
  if (claim.state === "claimed") return "splash.state.claimed";
  if (claim.state === "burned") return "splash.state.burned";
  if (claim.paymentStatus === "unknown") return "splash.state.confirming";
  if (claim.state === "expired") return "splash.state.expired";
  return "splash.state.open";
}

/** My SPLASH: my bids, my wins with their claim deadline, and claiming. */
export function mountMine(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const { text, locale } = context;
  if (!context.authenticated) {
    container.append(EmptyState({ message: text("splash.guest") }));
    return () => undefined;
  }
  const timers: { dispose(): void }[] = [];
  const stopTimers = () => {
    for (const timer of timers.splice(0)) timer.dispose();
  };
  const status = LiveRegion();
  const body = Group();
  container.append(status, body);
  const picture = (submissionId: string, alt: MessageKey) =>
    Picture({
      src: context.client.imageUrl(
        `/v1/splash/submissions/${submissionId}/image`,
      ),
      alt: text(alt),
      fallback: text("splash.imageMissing"),
      size: "thumb",
    });

  function bidItem(bid: OwnBid) {
    const facts: { label: string; value: string | Node }[] = [
      { label: text("splash.yourBid"), value: jpegpe(locale, bid.amount) },
      { label: text("splash.claimName"), value: bid.name },
    ];
    if (bid.status === "active") {
      const left = Countdown({
        until: bid.roundEndsAt,
        label: text("splash.timeLeftLabel"),
        format: clock,
      });
      timers.push(left);
      facts.push({ label: text("splash.timeLeft"), value: left.element });
    }
    return ListItem({
      leading: picture(bid.submissionId, "splash.frogAlt"),
      title: text("splash.roundTitle", { round: String(bid.roundId) }),
      children: [Facts(facts), Badge(text(`splash.bidStatus.${bid.status}`))],
    });
  }

  function claimItem(claim: Claim) {
    const facts: { label: string; value: string | Node }[] = [
      { label: text("splash.claimPrice"), value: jpegpe(locale, claim.amount) },
      {
        label: text("splash.claimName"),
        value: claim.name ?? text("splash.nameAtClaim"),
      },
    ];
    const actions: Node[] = [];
    const notes: Node[] = [];
    const badge = claimBadge(claim);
    if (badge === "splash.state.open") {
      const left = Countdown({
        until: claim.claimDeadline,
        label: text("splash.claimLeftLabel"),
        format: clock,
        onEnd: () => void load(),
      });
      timers.push(left);
      facts.push(
        {
          label: text("splash.claimDeadline"),
          value: utcMoment(locale, claim.claimDeadline),
        },
        { label: text("splash.claimLeft"), value: left.element },
      );
      const start: HTMLButtonElement = Button(text("splash.claim"), {
        variant: "primary",
        onClick: () => {
          openClaimSheet(context, claim, {
            opener: start,
            onDone: (message) => {
              status.replaceChildren(Text(message));
              void load();
            },
          });
        },
      });
      actions.push(start);
    }
    if (badge === "splash.state.confirming")
      actions.push(
        Button(text("splash.checkAgain"), {
          onClick: () => void recheck(claim.submissionId),
        }),
      );
    if (badge === "splash.state.claimed")
      actions.push(
        Button(text("splash.openCollection"), {
          onClick: () => {
            context.openWallet();
          },
        }),
      );
    notes.push(Text(text(`${badge}Note` as MessageKey)));
    return ListItem({
      leading: picture(claim.submissionId, "splash.frogAlt"),
      title: claim.name ?? text("splash.unnamedWin"),
      children: [
        Badge(text(badge), {
          tone: badge === "splash.state.claimed" ? "strong" : "neutral",
        }),
        Facts(facts),
        ...notes,
      ],
      actions,
    });
  }

  async function recheck(frogId: string) {
    try {
      const claim = await context.client.claim(frogId, context.signal);
      status.replaceChildren(Text(text(claimBadge(claim))));
    } catch {
      if (context.signal.aborted) return;
    }
    void load();
  }

  async function render(): Promise<Node[]> {
    stopTimers();
    const [bids, claims] = await Promise.all([
      context.client.myBids(context.signal),
      context.client.myClaims(context.signal),
    ]);
    const claimed = new Set(claims.map((claim) => claim.submissionId));
    const open = bids.filter(
      (bid) => bid.status !== "won" || !claimed.has(bid.submissionId),
    );
    return [
      Section({
        title: text("splash.winsTitle"),
        children: claims.length
          ? [
              List({
                label: text("splash.winsTitle"),
                children: claims.map(claimItem),
              }),
            ]
          : [EmptyState({ message: text("splash.noWins") })],
      }),
      Section({
        title: text("splash.bidsTitle"),
        children: open.length
          ? [
              List({
                label: text("splash.bidsTitle"),
                children: open.map(bidItem),
              }),
            ]
          : [EmptyState({ message: text("splash.noBidsYet") })],
      }),
    ];
  }
  const load = () => loadInto(context, body, render);
  void load();
  return stopTimers;
}
