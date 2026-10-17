import {
  Actions,
  Button,
  ErrorState,
  FrogCard,
  Group,
  LiveRegion,
  Loading,
  Text,
} from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type { OwnFrog } from "../../../packages/platform-sdk/src/index.ts";

export function mountProfile(
  container: HTMLElement,
  options: {
    locale: Locale;
    selected: Omit<OwnFrog, "artwork_path"> | null;
    select(frogId: string | null, signal: AbortSignal): Promise<void>;
    artwork(path: string, signal: AbortSignal): Promise<Blob>;
    openCollection(): void;
    refresh(): void;
  },
): () => void {
  const controller = new AbortController();
  const text = (key: Parameters<typeof t>[1]) => t(options.locale, key);
  const status = LiveRegion();
  const selected = options.selected;
  if (selected) {
    const hero = Group([
      FrogCard(selected, {
        missingArtLabel: text("profile.artUnavailable"),
        ...(selected.artwork_url
          ? {
              artwork: {
                load: (signal: AbortSignal) =>
                  options.artwork(selected.artwork_url ?? "", signal),
                signal: controller.signal,
              },
            }
          : {}),
      }),
    ]);
    hero.dataset.selectedFrog = "true";
    container.append(hero);
  }
  const clear = Button(text("profile.clear"), {
    onClick: () => {
      clear.disabled = true;
      status.replaceChildren(Loading({ message: text("profile.saving") }));
      void options
        .select(null, controller.signal)
        .then(() => {
          if (!controller.signal.aborted) options.refresh();
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          clear.disabled = false;
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
    },
  });
  container.append(
    Text(
      text(selected ? "profile.publicDescription" : "shell.privateDescription"),
    ),
    Actions([
      Button(text("collection.change"), {
        variant: "primary",
        onClick: () => {
          options.openCollection();
        },
      }),
      Button(text("collection.open"), {
        onClick: () => {
          options.openCollection();
        },
      }),
      ...(selected ? [clear] : []),
    ]),
    status,
  );
  return () => {
    controller.abort();
  };
}
