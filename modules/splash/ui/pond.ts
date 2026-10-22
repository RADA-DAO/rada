import {
  Actions,
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
import type { Lot, OwnBid, Round } from "./api.ts";
import { openBidSheet } from "./bid-sheet.ts";
import { loadInto, type SplashContext } from "./context.ts";
import { clock, jpegpe } from "./format.ts";

/** The pond: public bidder counts and private own bids. */
export function mountPond(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const { text, locale } = context;
  const timers: { dispose(): void }[] = [];
  const status = LiveRegion();
  const body = Group();
  const stopTimers = () => {
    for (const timer of timers.splice(0)) timer.dispose();
  };
  const nav = Actions([
    Button(text("splash.submitTitle"), {
      onClick: () => {
        context.open("splash-submit");
      },
    }),
    Button(text("splash.mineTitle"), {
      onClick: () => {
        context.open("splash-mine");
      },
    }),
    Button(text("splash.resultsTitle"), {
      onClick: () => {
        context.open("splash-results");
      },
    }),
  ]);
  container.append(Text(text("splash.intro")), nav, status, body);

  function lotItem(round: Round, lot: Lot, own: OwnBid | undefined) {
    const author = lot.author?.username ?? text("splash.anonymous");
    const actions: Node[] = [];
    if (round.acceptingBids && context.authenticated) {
      const bid: HTMLButtonElement = Button(
        text(own ? "splash.editBid" : "splash.placeBid"),
        {
          variant: own ? "secondary" : "primary",
          ariaLabel: text(own ? "splash.editBidFor" : "splash.bidFor", {
            author: `${author} · ${lot.submissionId}`,
          }),
          onClick: () => {
            openBidSheet(context, lot, own, {
              opener: bid,
              onPlaced: (contested) => {
                status.replaceChildren(
                  Text(
                    text(
                      contested
                        ? "splash.bidPlacedContested"
                        : "splash.bidPlaced",
                    ),
                  ),
                );
                void load();
              },
            });
          },
        },
      );
      bid.dataset.focusKey = `bid:${lot.submissionId}`;
      actions.push(bid);
    }
    return ListItem({
      title: text("splash.byAuthor", { author }),
      leading: Picture({
        src: lot.imageUrl,
        alt: text("splash.frogByAlt", { author }),
        fallback: text("splash.imageMissing"),
        size: "thumb",
      }),
      children: [
        Facts([
          { label: text("splash.bidders"), value: String(lot.bidderCount) },
          ...(own
            ? [
                {
                  label: text("splash.yourBid"),
                  value: `${jpegpe(locale, own.amount)} · ${own.name}`,
                },
              ]
            : []),
        ]),
        ...(own?.nameContested ? [Badge(text("splash.nameContested"))] : []),
      ],
      actions,
    });
  }

  async function render(): Promise<Node[]> {
    stopTimers();
    const [round, bids] = await Promise.all([
      context.client.round(context.signal),
      context.authenticated
        ? context.client.myBids(context.signal)
        : Promise.resolve([]),
    ]);
    if (!round) return [EmptyState({ message: text("splash.noRound") })];
    const own = new Map(
      bids
        .filter((bid) => bid.roundId === round.roundId)
        .map((bid) => [bid.submissionId, bid]),
    );
    const left = Countdown({
      until: round.endsAt,
      label: text("splash.timeLeftLabel"),
      format: clock,
      onEnd: () => void load(),
    });
    timers.push(left);
    const summary = Section({
      title: text("splash.roundTitle", { round: String(round.roundId) }),
      children: [
        Facts([{ label: text("splash.timeLeft"), value: left.element }]),
        Text(text("splash.roundRule")),
        ...(context.authenticated ? [] : [Text(text("splash.guest"))]),
        ...(round.acceptingBids ? [] : [Text(text("splash.roundClosing"))]),
      ],
    });
    const lots = round.lots.length
      ? [
          List({
            label: text("splash.lotsLabel"),
            children: round.lots.map((lot) =>
              lotItem(round, lot, own.get(lot.submissionId)),
            ),
          }),
        ]
      : [EmptyState({ message: text("splash.emptyRound") })];
    return [summary, ...lots];
  }
  const load = () => loadInto(context, body, render);
  void load();
  return stopTimers;
}
