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
  mount(
    app: PublishedApp,
    container: HTMLElement,
    origin: string,
  ): Promise<() => void>;
  render(): void;
}) {
  const lifecycle = new AbortController();
  let status: Status = options.authenticated ? "loading" : "guest";
  let apps: PublishedApp[] = [];
  let generation = 0;
  let running: { app: PublishedApp; frame: HTMLElement } | undefined;
  let failed: PublishedApp | undefined;
  const text = (
    key: Parameters<typeof t>[1],
    values?: Record<string, string>,
  ) => t(options.locale(), key, values);

  async function load() {
    if (!options.authenticated) return;
    const id = ++generation;
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
    return AppGrid({
      label: text("home.gridLabel"),
      tiles: apps.map((app) =>
        AppTile({
          name: app.manifest.name,
          tier: app.manifest.trustLevel,
          tierLabel: text(`home.tier.${app.manifest.trustLevel}`),
          onOpen: () => {
            open(app);
          },
        }),
      ),
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
      if (status === "guest")
        content.push(
          EmptyState({
            title: text("home.guestTitle"),
            message: text("home.guestDescription"),
          }),
        );
      else if (status === "loading")
        content.push(Loading({ message: text("home.loading") }));
      else if (status === "ready" && apps.length) content.push(tiles());
      else if (status === "ready")
        content.push(
          EmptyState({
            title: text("home.emptyTitle"),
            message: text("home.emptyDescription"),
          }),
        );
      else
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
    },
  };
}
