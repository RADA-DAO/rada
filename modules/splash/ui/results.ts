import {
  Button,
  EmptyState,
  Facts,
  Group,
  List,
  ListItem,
  Picture,
  Section,
} from "../../../packages/ui/src/index.ts";
import { SplashError, type ResultLot } from "./api.ts";
import { loadInto, type SplashContext } from "./context.ts";
import { jpegpe, utcDay, utcMoment } from "./format.ts";

/** Past rounds, newest first: one closed round at a time with Older/Newer. */
export function mountResults(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const { text, locale } = context;
  const body = Group();
  container.append(body);
  let latest: number | undefined;
  let shown: number | undefined;

  function lotItem(lot: ResultLot) {
    const winner = lot.winner?.username ?? text("splash.anonymous");
    const facts =
      lot.outcome === "won" && lot.amount
        ? [
            {
              label: text("splash.winningBid"),
              value: jpegpe(locale, lot.amount),
            },
            { label: text("splash.winner"), value: winner },
            {
              label: text("splash.claimName"),
              value: lot.name ?? text("splash.nameAtClaim"),
            },
            ...(lot.claimDeadline === null
              ? []
              : [
                  {
                    label: text("splash.claimDeadline"),
                    value: utcMoment(locale, lot.claimDeadline),
                  },
                ]),
          ]
        : [{ label: text("splash.outcome"), value: text("splash.noBidsBack") }];
    return ListItem({
      leading: Picture({
        src: lot.imageUrl,
        alt: text("splash.frogAlt"),
        fallback: text("splash.imageMissing"),
        size: "thumb",
      }),
      title: text(lot.outcome === "won" ? "splash.won" : "splash.unsold"),
      children: [Facts(facts)],
    });
  }

  async function render(): Promise<Node[]> {
    if (latest === undefined) {
      const round = await context.client.round(context.signal);
      latest = (round?.roundId ?? 1) - 1;
      shown = latest;
    }
    if (!shown || shown < 1)
      return [EmptyState({ message: text("splash.noResults") })];
    let results;
    try {
      results = await context.client.results(shown, context.signal);
    } catch (error) {
      if (error instanceof SplashError && error.message === "not_found")
        return [EmptyState({ message: text("splash.noResults") })];
      throw error;
    }
    const target = shown;
    const pager: Node[] = [];
    if (target > 1)
      pager.push(
        Button(text("splash.olderRound"), {
          onClick: () => {
            shown = target - 1;
            void load();
          },
        }),
      );
    if (target < latest)
      pager.push(
        Button(text("splash.newerRound"), {
          onClick: () => {
            shown = target + 1;
            void load();
          },
        }),
      );
    return [
      Section({
        title: text("splash.resultsRound", {
          round: String(results.roundId),
          day: utcDay(locale, results.startsAt),
        }),
        children: results.lots.length
          ? [
              List({
                label: text("splash.resultsLabel"),
                children: results.lots.map(lotItem),
              }),
            ]
          : [EmptyState({ message: text("splash.emptyResults") })],
      }),
      ...pager,
    ];
  }
  const load = () => loadInto(context, body, render);
  void load();
  return () => undefined;
}
