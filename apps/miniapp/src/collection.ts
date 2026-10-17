import {
  Actions,
  Button,
  EmptyState,
  ErrorState,
  Facts,
  FrogCard,
  FrogGallery,
  Group,
  List,
  ListItem,
  Loading,
  Screen,
  Section,
  Tabs,
  Text,
} from "../../../packages/ui/src/index.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
import type {
  initializePlatform,
  OwnFrog,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";

export function showCollection(
  host: HTMLElement,
  options: {
    locale: Locale;
    platform: ReturnType<typeof initializePlatform>;
    navigation: Navigation;
    selected: string | null;
    frogId: string | null;
    actions: Node[];
    refresh(): void;
    openFrog(id: string): void;
  },
): () => void {
  const lifecycle = new AbortController();
  let images = new AbortController();
  let size: "large" | "medium" | "compact" = "large";
  let frogs: OwnFrog[] = [];
  let pending = false;
  const text = (key: MessageKey) => t(options.locale, key);
  const content = Group();
  const show = (title: string, children: Node[]) => {
    content.replaceChildren(...children);
    host.replaceChildren(
      Screen({
        title,
        brand: text("shell.brand"),
        actions: options.actions,
        children: [content],
      }),
    );
  };
  const failure = (retry: () => void) =>
    ErrorState({
      message: text("shell.unavailableDescription"),
      retryLabel: text("common.retry"),
      onRetry: retry,
    });
  const card = (frog: OwnFrog) =>
    FrogCard(frog, {
      missingArtLabel: text("profile.artUnavailable"),
      ...(frog.artwork_url
        ? {
            artwork: {
              load: (signal: AbortSignal) =>
                options.platform.readFrogArtwork(
                  frog.artwork_url ?? "",
                  signal,
                ),
              signal: images.signal,
            },
          }
        : frog.artwork_path
          ? {
              image: {
                url: frog.artwork_path,
                alt: frog.username.toUpperCase(),
              },
            }
          : {}),
    });
  function grid() {
    images.abort();
    images = new AbortController();
    show(text("profile.collection"), [
      Text(text("collection.private")),
      Tabs({
        label: text("collection.size"),
        selected: size,
        tabs: (["large", "medium", "compact"] as const).map((value) => ({
          id: value,
          label: text(`collection.${value}`),
          onSelect: () => {
            size = value;
            grid();
          },
        })),
      }),
      ...(frogs.length
        ? [
            FrogGallery({
              label: text("profile.collection"),
              size,
              items: frogs.map((frog) => ({
                card: card(frog),
                label: t(options.locale, "collection.view", {
                  name: frog.username.toUpperCase(),
                }),
                selected: options.selected === frog.frog_id,
                onOpen: () => {
                  options.openFrog(frog.frog_id);
                },
              })),
            }),
          ]
        : [EmptyState({ message: text("profile.emptyCollection") })]),
    ]);
  }
  async function detail(frog: OwnFrog) {
    images.abort();
    images = new AbortController();
    const details = Group([Loading({ message: text("common.loading") })]);
    const status = Group();
    const selected = frog.frog_id === options.selected;
    const select = Button(
      t(
        options.locale,
        selected ? "profile.selectedName" : "profile.selectName",
        { name: frog.username.toUpperCase() },
      ),
      {
        variant: "primary",
        disabled: selected,
        onClick: () => {
          if (pending) return;
          pending = true;
          select.disabled = true;
          status.replaceChildren(Loading({ message: text("profile.saving") }));
          void options.platform
            .selectProfileFrog(frog.frog_id, lifecycle.signal)
            .then(() => {
              if (lifecycle.signal.aborted) return;
              options.navigation.push({ key: "profile", edgeBack: true });
              options.refresh();
            })
            .catch((error: unknown) => {
              if (lifecycle.signal.aborted) return;
              pending = false;
              select.disabled = false;
              status.replaceChildren(
                Text(
                  text(
                    error instanceof Error && error.message === "not_owned"
                      ? "profile.notOwned"
                      : "shell.unavailableDescription",
                  ),
                ),
              );
            });
        },
      },
    );
    show(frog.username.toUpperCase(), [
      card(frog),
      Text(text("collection.permanent")),
      Actions([select]),
      status,
      details,
    ]);
    try {
      const data = await options.platform.readFrogDetails(
        frog.frog_id,
        lifecycle.signal,
      );
      if (lifecycle.signal.aborted) return;
      const name = (value: string | null) =>
        value?.toUpperCase() ?? text("collection.anonymous");
      const history = List({ label: text("collection.history") });
      for (const event of data.history)
        history.append(
          ListItem({
            children: [
              Text(
                new Intl.DateTimeFormat(options.locale, {
                  dateStyle: "medium",
                  timeZone: "UTC",
                }).format(new Date(event.at)),
              ),
              Text(
                t(options.locale, "collection.transfer", {
                  from: name(event.from),
                  to: name(event.to),
                }),
              ),
            ],
          }),
        );
      details.replaceChildren(
        Facts([
          { label: text("collection.creator"), value: name(data.creator) },
          { label: text("collection.owner"), value: name(data.owner) },
          {
            label: text("collection.background"),
            value: frog.background_color ?? text("collection.unset"),
          },
          {
            label: text("collection.accent"),
            value: frog.accent_color ?? text("collection.unset"),
          },
        ]),
        ...(data.colour_source === "legacy_unverified"
          ? [Text(text("collection.legacy"))]
          : []),
        Section({
          title: text("collection.history"),
          children: data.history.length
            ? [history]
            : [Text(text("collection.noHistory"))],
        }),
      );
    } catch {
      if (!lifecycle.signal.aborted)
        details.replaceChildren(failure(() => void detail(frog)));
    }
  }
  async function load() {
    show(text("profile.collection"), [
      Loading({ message: text("common.loading") }),
    ]);
    try {
      frogs = await options.platform.readOwnFrogs(lifecycle.signal);
      if (lifecycle.signal.aborted) return;
      if (!options.frogId) grid();
      else {
        const frog = frogs.find((item) => item.frog_id === options.frogId);
        if (frog) void detail(frog);
        else show(text("profile.collection"), [Text(text("profile.notOwned"))]);
      }
    } catch {
      if (!lifecycle.signal.aborted)
        show(text("profile.collection"), [failure(() => void load())]);
    }
  }
  void load();
  return () => {
    lifecycle.abort();
    images.abort();
  };
}
