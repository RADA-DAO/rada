import {
  Button,
  EmptyState,
  Group,
  List,
  ListItem,
  Picture,
  Section,
  Text,
} from "../../../packages/ui/src/index.ts";
import { loadInto, type SplashContext } from "./context.ts";

/** Only the viewer's pending submissions belong on the next-round bench. */
export function mountQueue(
  container: HTMLElement,
  context: SplashContext,
): () => void {
  const { text } = context;
  const heading = Section({ title: text("splash.queueTitle") });
  heading.prepend(Text(text("splash.nextRound")));
  const body = Group();
  container.classList.add("splash-queue");
  container.append(heading, Text(text("splash.submitIntro")), body);
  if (!context.authenticated) {
    body.append(EmptyState({ message: text("splash.guest") }));
    return () => {};
  }
  container.append(
    Button(text("splash.submitTitle"), {
      onClick: () => {
        context.open("splash-submit");
      },
    }),
  );
  void loadInto(
    context,
    body,
    async () => {
      const [submissions, round] = await Promise.all([
        context.client.mySubmissions(context.signal),
        context.client.round(context.signal),
      ]);
      const active = new Set(round?.lots.map((lot) => lot.submissionId));
      const queue = submissions.filter(
        (item) => item.state === "in_pond" && !active.has(item.submissionId),
      );
      if (!queue.length)
        return [EmptyState({ message: text("splash.emptyQueue") })];
      const list = List({
        label: text("splash.queueTitle"),
        children: queue.map((item) =>
          ListItem({
            leading: Picture({
              src: item.imageUrl,
              alt: text("splash.frogAlt"),
              fallback: text("splash.imageMissing"),
            }),
          }),
        ),
      });
      list.classList.add("splash-queue-slots");
      return [list];
    },
    "splash.loadError.submissions",
  );
  return () => {};
}
