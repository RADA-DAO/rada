import {
  AppGrid,
  AppTile,
  Embed,
  EmptyState,
  ErrorState,
  Identity,
  Loading,
} from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
import type {
  OwnProfile,
  PublishedApp,
} from "../../../packages/platform-sdk/src/index.ts";

type Status = "guest" | "loading" | "ready" | "expired" | "unavailable";
export type HomeIdentity = {
  authenticated: boolean;
  visibility: string;
  frog: OwnProfile["profile"]["public"];
};

/**
 * The launcher: published apps as tiles, plus the app the viewer opened from
 * it. Opening pushes the app onto the platform stack; Back and swipe pop it.
 */
export function createHome(options: {
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
  /** Official apps built into the shell, shown before registry apps for everyone. */
  builtIn(): { name: string; onOpen(): void }[];
}) {
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
    const shown = status === "ready" ? apps : [];
    return AppGrid({
      label: text("home.gridLabel"),
      tiles: [
        ...options.builtIn().map((app) =>
          AppTile({
            name: app.name,
            tier: "official",
            tierLabel: text("home.tier.official"),
            onOpen: () => {
              app.onOpen();
            },
          }),
        ),
        ...shown.map((app) =>
          AppTile({
            name: app.manifest.name,
            tier: app.tier,
            tierLabel: text(`home.tier.${app.tier}`),
            ...(app.iconUrl && icons.has(app.iconUrl)
              ? { iconUrl: icons.get(app.iconUrl) as string }
              : {}),
            onOpen: () => {
              open(app);
            },
          }),
        ),
      ],
    });
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
    identity(viewer: HomeIdentity): HTMLElement {
      if (viewer.frog)
        return Identity({
          name: viewer.frog.username,
          caption: text("shell.public"),
        });
      if (!viewer.authenticated)
        return Identity({
          name: text("home.identityGuest"),
          caption: text("shell.guest"),
        });
      return Identity({
        name: text("home.identityMember"),
        ...(viewer.visibility === "private"
          ? { caption: text("shell.private") }
          : {}),
      });
    },
    content(): Node[] {
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
      if (status === "guest")
        content.push(
          EmptyState({
            title: text("home.guestTitle"),
            message: text("home.guestDescription"),
          }),
        );
      else if (status === "loading")
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
      lifecycle.abort();
      generation++;
      dropIcons();
    },
  };
}
