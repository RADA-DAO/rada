import {
  Button,
  ErrorState,
  FrogCard,
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
  let pending = false;
  const text = (key: Parameters<typeof t>[1]) => t(options.locale, key);
  const status = document.createElement("div");
  status.setAttribute("aria-live", "polite");
  const collection = document.createElement("div");
  collection.className = "profile-collection";
  const title = document.createElement("h2");
  title.textContent = text("profile.collection");
  async function select(frogId: string | null) {
    if (pending || disposed) return;
    pending = true;
    for (const button of container.querySelectorAll("button"))
      button.disabled = true;
    status.textContent = text("profile.saving");
    try {
      await options.select(frogId, controller.signal);
      if (!disposed) options.refresh();
    } catch (error) {
      if (disposed) return;
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
          onRetry: options.refresh,
        }),
      );
    } finally {
      pending = false;
      if (!disposed)
        for (const button of container.querySelectorAll("button"))
          button.disabled =
            button.dataset.selectFrog === options.selected?.frog_id;
    }
  }
  const selectedCard = document.createElement("div");
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
  const privacy = document.createElement("p");
  privacy.textContent = text(
    options.selected ? "profile.publicDescription" : "shell.privateDescription",
  );
  status.textContent = text("common.loading");
  container.append(privacy, title, collection, status);
  void options
    .read(controller.signal)
    .then((frogs) => {
      if (disposed) return;
      status.textContent = frogs.length ? "" : text("profile.emptyCollection");
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
        const row = document.createElement("div");
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
        row.append(card(frog), button);
        collection.append(row);
      }
    })
    .catch(() => {
      if (!disposed)
        status.replaceChildren(
          ErrorState({
            message: text("shell.unavailableDescription"),
            retryLabel: text("common.retry"),
            onRetry: options.refresh,
          }),
        );
    });
  return () => {
    disposed = true;
    controller.abort();
  };
}
