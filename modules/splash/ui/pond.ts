import {
  Badge,
  Button,
  Countdown,
  EmptyState,
  Facts,
  FrogCard,
  ErrorState,
  Group,
  List,
  ListItem,
  LiveRegion,
  Picture,
  Section,
  openSheet,
  Text,
} from "../../../packages/ui/src/index.ts";
import type { Lot, OwnBid, Round } from "./api.ts";
import { openBidSheet } from "./bid-sheet.ts";
import { loadInto, type SplashContext } from "./context.ts";
import { clock } from "./format.ts";

/** The pond: public bidder counts and private own bids. */
export function mountPond(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const { text } = context;
  const status = LiveRegion();
  const body = Group();
  container.classList.add("splash-market");
  container.append(status, body);

  function lotItem(
    round: Round,
    lot: Lot,
    own: OwnBid | undefined,
    isCreator: boolean,
    canBid: boolean,
  ) {
    const author = lot.author?.username ?? text("splash.anonymous");
    const actions: Node[] = [];
    if (isCreator) {
      const view = Button(text("splash.yourWork"), {
        ariaLabel: text("splash.viewOwnFrog"),
        onClick: () => {
          const left = Countdown({
            until: round.endsAt,
            label: text("splash.timeLeftLabel"),
            format: clock,
          });
          const dialog = openSheet({
            title: text("splash.yourWork"),
            closeLabel: text("common.close"),
            navigation: context.navigation,
            opener: view,
            onClose: () => {
              left.dispose();
            },
            children: [
              Picture({
                src: lot.imageUrl,
                alt: text("splash.frogAlt"),
                fallback: text("splash.imageMissing"),
              }),
              Text(text("splash.ownFrogNote")),
              Facts([
                { label: text("splash.finishLabel"), value: left.element },
              ]),
            ],
          });
          dialog.classList.add("splash-sheet", "splash-sheet--bid");
        },
      });
      actions.push(view);
    } else if (round.acceptingBids && context.authenticated && canBid) {
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
                roundSnapshot = undefined;
                pending.bids = requests.bids();
                supplements = settle();
                void load();
              },
            });
          },
        },
      );
      bid.dataset.focusKey = `bid:${lot.submissionId}`;
      actions.push(bid);
    }
    const card = FrogCard(
      { username: "", background_color: null, accent_color: null },
      {
        missingArtLabel: text("splash.imageMissing"),
        artwork: {
          signal: context.signal,
          load: async (signal) => {
            const response = await fetch(lot.imageUrl, {
              signal,
              credentials: "omit",
            });
            if (!response.ok) throw new Error("unavailable");
            return response.blob();
          },
        },
      },
    );
    // Unrevealed submissions have neither collectible chrome nor a HUD cutout.
    card.classList.add("splash-submission-card");
    for (const layer of card.querySelectorAll<HTMLElement>("[style]"))
      layer.style.removeProperty("mask-image");
    // Submissions receive their permanent name only after the round closes.
    card.querySelector(".frog-card-username")?.remove();
    card.setAttribute("role", "img");
    card.setAttribute("aria-label", text("splash.frogByAlt", { author }));
    const participants = Badge(String(lot.bidderCount));
    participants.classList.add("splash-lot-count");
    participants.setAttribute(
      "aria-label",
      `${text("splash.bidders")}: ${String(lot.bidderCount)}`,
    );
    const item = ListItem({
      title: text("splash.byAuthor", { author }),
      leading: card,
      children: [
        participants,
        ...(isCreator ? [Badge(text("splash.yourWork"))] : []),
        ...(own ? [Badge(text("splash.yourBid"))] : []),
        ...(own?.nameContested ? [Badge(text("splash.nameContested"))] : []),
      ],
      actions,
    });
    const surface = actions[0];
    if (surface instanceof HTMLButtonElement) {
      surface.remove();
      item.querySelector(".rada-actions")?.remove();
      surface.replaceChildren(...Array.from(item.childNodes));
      surface.classList.add("splash-lot-surface");
      item.replaceChildren(surface);
    }
    item.classList.add("splash-lot");
    if (own) item.classList.add("has-my-bid");
    return item;
  }

  const requests = {
    bids: () => context.client.myBids(context.signal),
    submissions: () => context.client.mySubmissions(context.signal),
    claims: () => context.client.myClaims(context.signal),
  };
  const pending = {
    bids: context.authenticated ? requests.bids() : Promise.resolve([]),
    submissions: context.authenticated
      ? requests.submissions()
      : Promise.resolve([]),
    claims: context.authenticated ? requests.claims() : Promise.resolve([]),
  };
  // Attach rejection handlers immediately, including while the public round loads.
  const settle = () =>
    Promise.allSettled([pending.bids, pending.submissions, pending.claims]);
  let supplements = settle();
  let roundSnapshot: Round | null | undefined;
  async function render(): Promise<Node[]> {
    const [round, secondary] = await Promise.all([
      roundSnapshot === undefined
        ? context.client.round(context.signal)
        : Promise.resolve(roundSnapshot),
      supplements,
    ]);
    roundSnapshot = round;
    const bidsResult = secondary[0];
    const submissionsResult = secondary[1];
    const claimsResult = secondary[2];
    const bids = bidsResult.status === "fulfilled" ? bidsResult.value : [];
    const submissions =
      submissionsResult.status === "fulfilled" ? submissionsResult.value : [];
    const claims =
      claimsResult.status === "fulfilled" ? claimsResult.value : [];
    const failures = (
      Object.keys(requests) as (keyof typeof requests)[]
    ).flatMap((key, index) => {
      if (secondary[index]?.status !== "rejected") return [];
      const notice = ErrorState({
        message: text(`splash.loadError.${key}`),
        retryLabel: text("common.retry"),
        onRetry: () => {
          if (key === "bids") pending.bids = requests.bids();
          if (key === "submissions")
            pending.submissions = requests.submissions();
          if (key === "claims") pending.claims = requests.claims();
          supplements = settle();
          void load();
        },
      });
      notice.classList.add("splash-inline-error");
      return [notice];
    });
    if (!round)
      return [
        EmptyState({ message: text("splash.noRound") }),
        ...failures,
        ...(bids.length || claims.length || failures.length
          ? [
              Button(text("splash.mineTitle"), {
                variant: "ghost",
                onClick: () => {
                  context.open("splash-mine");
                },
              }),
            ]
          : []),
      ];
    const created = new Set(submissions.map((item) => item.submissionId));
    const own = new Map(
      bids
        .filter((bid) => bid.roundId === round.roundId)
        .map((bid) => [bid.submissionId, bid]),
    );
    const heading = Section({ title: text("splash.frogsInPlay") });
    heading.classList.add("splash-market-heading");
    const title = heading.querySelector("h2");
    title?.append(Badge(String(round.lots.length)));
    const eyebrow = Text(text("splash.activeRound"));
    heading.prepend(eyebrow);
    const rules = Button(text("splash.rules"), {
      variant: "ghost",
      onClick: () => {
        const dialog = openSheet({
          title: text("splash.rules"),
          closeLabel: text("common.close"),
          navigation: context.navigation,
          opener: rules,
          children: [
            Text(text("splash.bidRule")),
            Text(text("splash.promise")),
            Text(text("splash.burnRule")),
            Text(text("splash.roundRule")),
            Text(text("splash.noUniqueRule")),
          ],
        });
        dialog.classList.add("splash-sheet");
      },
    });
    heading.append(rules);
    const lots = round.lots.length
      ? [
          List({
            label: text("splash.lotsLabel"),
            children: round.lots.map((lot) =>
              lotItem(
                round,
                lot,
                own.get(lot.submissionId),
                created.has(lot.submissionId),
                bidsResult.status === "fulfilled" &&
                  submissionsResult.status === "fulfilled",
              ),
            ),
          }),
        ]
      : [EmptyState({ message: text("splash.emptyRound") })];
    const list = lots[0];
    if (round.lots.length && list instanceof HTMLElement)
      list.classList.add("splash-lots");
    return [
      heading,
      ...lots,
      ...failures,
      ...(bids.length || claims.length || failures.length
        ? [
            Button(text("splash.mineTitle"), {
              variant: "ghost",
              onClick: () => {
                context.open("splash-mine");
              },
            }),
          ]
        : context.authenticated
          ? []
          : [Text(text("splash.guest"))]),
      ...(round.acceptingBids ? [] : [Text(text("splash.roundClosing"))]),
    ];
  }
  const load = () => loadInto(context, body, render);
  void load();
  return () => {};
}
