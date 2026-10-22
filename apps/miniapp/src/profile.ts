import {
  ProfileFrogCard,
  profileActionIcon,
} from "../../../packages/ui/src/frog-card.ts";
import {
  Actions,
  Button,
  ErrorState,
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
  const hero = Group([
    ProfileFrogCard(selected, {
      emptyLabel: text("shell.private"),
      missingArtLabel: text("profile.artUnavailable"),
      ...(selected?.artwork_url
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
  if (selected) hero.dataset.selectedFrog = "true";
  container.append(hero);
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
  const details = Group([
    Text(
      text(selected ? "profile.publicDescription" : "shell.privateDescription"),
    ),
    ...(selected ? [clear] : []),
    status,
  ]);
  details.dataset.profileDetails = "true";
  const actions = Actions([
    profileActionIcon(
      Button(text("collection.change"), {
        onClick: () => {
          options.openCollection();
        },
      }),
      "appearance",
    ),
    profileActionIcon(
      Button(text("collection.open"), {
        onClick: () => {
          options.openCollection();
        },
      }),
      "collection",
    ),
  ]);
  actions.classList.add("rada-profile-actions");
  container.append(actions, details);
  return () => {
    controller.abort();
  };
}
