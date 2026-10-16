import {
  Button,
  EmptyState,
  ErrorState,
  FrogCard,
  Group,
  List,
  ListItem,
  LiveRegion,
  Loading,
  Section,
  Text,
} from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type { OwnFrog } from "../../../packages/platform-sdk/src/index.ts";

export function mountProfile(
  container: HTMLElement,
  options: {
    locale: Locale;
    selected: Omit<OwnFrog, "artwork_path"> | null;
    read(signal: AbortSignal): Promise<OwnFrog[]>;
    select(frogId: string | null, signal: AbortSignal): Promise<void>;
    refresh(): void;
  },
): () => void {
  const controller = new AbortController();
  let disposed = false;
  const isDisposed = () => disposed;
  let pending = false;
  const text = (key: Parameters<typeof t>[1]) => t(options.locale, key);
  const status = LiveRegion();
  const collection = List({ label: text("profile.collection") });
  async function select(frogId: string | null) {
    if (pending || disposed) return;
    pending = true;
    for (const button of container.querySelectorAll("button"))
      button.disabled = true;
    status.replaceChildren(Loading({ message: text("profile.saving") }));
    try {
      await options.select(frogId, controller.signal);
      if (!isDisposed()) options.refresh();
    } catch (error) {
      if (isDisposed()) return;
      status.replaceChildren(
        ErrorState({
          message: text(
            error instanceof Error && error.message === "expired"
              ? "shell.expiredDescription"
              : error instanceof Error && error.message === "not_owned"
                ? "profile.notOwned"
                : "shell.unavailableDescription",
          ),
          retryLabel: text("common.retry"),
          onRetry: () => {
            options.refresh();
          },
        }),
      );
    } finally {
      pending = false;
      if (!isDisposed())
        for (const button of container.querySelectorAll("button"))
          button.disabled =
            button.dataset.selectFrog === options.selected?.frog_id;
    }
  }
  const selectedCard = Group();
  selectedCard.dataset.selectedFrog = "true";
  if (options.selected) {
    selectedCard.append(
      FrogCard(options.selected, {
        missingArtLabel: text("profile.artUnavailable"),
      }),
    );
    container.append(
      selectedCard,
      Button(text("profile.clear"), { onClick: () => void select(null) }),
    );
  }
  status.replaceChildren(Loading({ message: text("common.loading") }));
  container.append(
    Text(
      text(
        options.selected
          ? "profile.publicDescription"
          : "shell.privateDescription",
      ),
    ),
    Section({
      title: text("profile.collection"),
      children: [collection, status],
    }),
  );
  void options
    .read(controller.signal)
    .then((frogs) => {
      if (disposed) return;
      status.replaceChildren(
        ...(frogs.length
          ? []
          : [EmptyState({ message: text("profile.emptyCollection") })]),
      );
      const selectedFrog = frogs.find(
        (frog) => frog.frog_id === options.selected?.frog_id,
      );
      if (options.selected && !selectedFrog) {
        options.refresh();
        return;
      }
      const card = (frog: OwnFrog) =>
        FrogCard(frog, {
          missingArtLabel: text("profile.artUnavailable"),
          ...(frog.artwork_path
            ? {
                image: {
                  url: frog.artwork_path,
                  alt: frog.username.toUpperCase(),
                },
              }
            : {}),
        });
      if (selectedFrog) selectedCard.replaceChildren(card(selectedFrog));
      for (const frog of frogs) {
        const selected = options.selected?.frog_id === frog.frog_id;
        const button = Button(
          t(
            options.locale,
            selected ? "profile.selectedName" : "profile.selectName",
            { name: frog.username.toUpperCase() },
          ),
          { onClick: () => void select(frog.frog_id), disabled: selected },
        );
        button.dataset.selectFrog = frog.frog_id;
        collection.append(
          ListItem({ children: [card(frog)], actions: [button] }),
        );
      }
    })
    .catch(() => {
      if (!disposed)
        status.replaceChildren(
          ErrorState({
            message: text("shell.unavailableDescription"),
            retryLabel: text("common.retry"),
            onRetry: () => {
              options.refresh();
            },
          }),
        );
    });
  return () => {
    disposed = true;
    controller.abort();
  };
}
