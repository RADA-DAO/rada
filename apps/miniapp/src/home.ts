import { createLauncherDesktop } from "./home-launcher.ts";
import {
  type AppTier,
  Embed,
  EmptyState,
  ErrorState,
  Loading,
} from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type {
  initializePlatform,
  Navigation,
  PublishedApp,
} from "../../../packages/platform-sdk/src/index.ts";

/** Catalog category is independent of the registry trust tier. */
export function launcherGroup(app: {
  id?: string;
  tier?: string;
  manifest?: { category?: string };
}): "rada" | "games" | "apps" {
  if (app.id === "builtin:splash" || app.manifest?.category === "games")
    return "games";
  return app.id?.startsWith("builtin:") || app.tier === "official"
    ? "rada"
    : "apps";
}

type Status = "guest" | "loading" | "ready" | "expired" | "unavailable";
/**
 * The launcher: published apps as tiles, plus the app the viewer opened from
 * it. Opening pushes the app onto the platform stack; Back and swipe pop it.
 */
export function createHome(options: {
  platform: ReturnType<typeof initializePlatform>;
  navigation: Navigation;
  locale(): Locale;
  authenticated: boolean;
  read(signal: AbortSignal): Promise<PublishedApp[]>;
  /** A local URL for an approved icon, or nothing when it cannot be used. */
  loadIcon(url: string, signal: AbortSignal): Promise<string | undefined>;
  mount(
    app: PublishedApp,
    container: HTMLElement,
    origin: string,
  ): Promise<() => void>;
  render(): void;
  /** Built-in apps in the shell, shown before registry apps for everyone. */
  builtIn(): {
    id: string;
    name: string;
    tier?: AppTier;
    iconUrl?: string;
    onOpen(): void;
  }[];
}) {
  const desktop = createLauncherDesktop({
    ...options,
    render() {
      if (!running && options.navigation.top.key === "launcher")
        options.render();
    },
  });
  const lifecycle = new AbortController();
  let status: Status = options.authenticated ? "loading" : "guest";
  let apps: PublishedApp[] = [];
  let generation = 0;
  const icons = new Map<string, string>();
  const dropIcons = () => {
    for (const url of icons.values()) URL.revokeObjectURL(url);
    icons.clear();
  };
  let running: { app: PublishedApp; frame: HTMLElement } | undefined;
  let failed: PublishedApp | undefined;
  const text = (
    key: Parameters<typeof t>[1],
    values?: Record<string, string>,
  ) => t(options.locale(), key, values);

  async function loadIcons(id: number) {
    const wanted = apps.flatMap((app) => (app.iconUrl ? [app.iconUrl] : []));
    const loaded = await Promise.all(
      wanted.map(
        async (url) =>
          [url, await options.loadIcon(url, lifecycle.signal)] as const,
      ),
    );
    const found = loaded.flatMap(([url, local]) =>
      local ? [[url, local] as const] : [],
    );
    if (id !== generation || lifecycle.signal.aborted) {
      for (const [, local] of found) URL.revokeObjectURL(local);
      return;
    }
    if (!found.length) return;
    for (const [url, local] of found) icons.set(url, local);
    // Re-rendering would move a running app's frame, so wait for the launcher.
    if (!running) options.render();
  }

  async function load() {
    if (!options.authenticated) return;
    const id = ++generation;
    dropIcons();
    status = "loading";
    options.render();
    try {
      const next = await options.read(lifecycle.signal);
      if (id !== generation) return;
      apps = next;
      status = "ready";
      void desktop.load();
    } catch (error) {
      if (id !== generation || lifecycle.signal.aborted) return;
      status =
        error instanceof Error && error.message === "expired"
          ? "expired"
          : "unavailable";
    }
    options.render();
    if (status === "ready") void loadIcons(id);
  }

  function open(app: PublishedApp) {
    if (running) return;
    desktop.opened(app.appId);
    failed = undefined;
    const frame = Embed({ fill: true });
    frame.replaceChildren(
      Loading({ message: text("home.opening", { app: app.manifest.name }) }),
    );
    const current = { app, frame };
    running = current;
    options.render();
    options.mount(app, frame, new URL(app.artifactUrl).origin).catch(() => {
      if (running !== current) return;
      running = undefined;
      failed = app;
      options.render();
    });
  }

  function tiles(): Node {
    return desktop.content([
      ...options.builtIn().map((app) => ({
        id: app.id,
        name: app.name,
        group: launcherGroup(app),
        ...(app.iconUrl ? { iconUrl: app.iconUrl } : {}),
        tier: app.tier ?? ("official" as const),
        tierLabel: text("home.tier.official"),
        onOpen() {
          desktop.opened(app.id);
          app.onOpen();
        },
      })),
      ...(status === "ready" ? apps : []).map((app) => ({
        id: app.appId,
        name: app.manifest.name,
        group: launcherGroup(app),
        tier: app.tier,
        tierLabel: text(`home.tier.${app.tier}`),
        ...(app.iconUrl && icons.has(app.iconUrl)
          ? { iconUrl: icons.get(app.iconUrl) as string }
          : {}),
        onOpen() {
          open(app);
        },
      })),
    ]);
  }

  return {
    load,
    /** The app opened from the launcher, while it is on the stack. */
    get running() {
      return (
        running && { name: running.app.manifest.name, frame: running.frame }
      );
    },
    /** Its stack entry left: Back, swipe or the app closing itself. */
    close() {
      running = undefined;
    },
    content(): Node[] {
      if (status === "guest") return [];
      const content: Node[] = [];
      if (failed) {
        const retry = failed;
        content.push(
          ErrorState({
            message: text("home.openFailed", { app: retry.manifest.name }),
            retryLabel: text("common.retry"),
            onRetry: () => {
              open(retry);
            },
          }),
        );
      }
      content.push(tiles());
      if (status === "loading")
        content.push(Loading({ message: text("home.loading") }));
      else if (status === "ready") {
        // Registry apps join the grid above; say so only when there are none.
        if (!apps.length)
          content.push(
            EmptyState({
              title: text("home.emptyTitle"),
              message: text("home.emptyDescription"),
            }),
          );
      } else
        content.push(
          ErrorState({
            message: text(
              status === "expired"
                ? "shell.expiredDescription"
                : "shell.unavailableDescription",
            ),
            retryLabel: text("common.retry"),
            onRetry: () => void load(),
          }),
        );
      return content;
    },
    dispose() {
      desktop.dispose();
      lifecycle.abort();
      generation++;
      dropIcons();
    },
  };
}
