import { createChunkLoader } from "./chunk-loader.ts";
import {
  Group,
  LauncherBrowser,
  ErrorState,
  type LauncherItem,
} from "../../../packages/ui/src/index.ts";
import type {
  initializePlatform,
  Navigation,
} from "../../../packages/platform-sdk/src/index.ts";
import {
  emptyLayout,
  type LauncherSnapshot,
} from "../../../packages/platform-sdk/src/launcher-layout.ts";
import {
  t,
  type Locale,
  type MessageKey,
} from "../../../packages/i18n/src/index.ts";
export function createLauncherDesktop(options: {
  locale(): Locale;
  platform: ReturnType<typeof initializePlatform>;
  navigation: Navigation;
  render(): void;
}) {
  const loadEditor = createChunkLoader(
    () => import("./desktop-screens.ts"),
    "launcher-editor",
  );
  const browserState = { query: "", group: "all" };
  let snapshot: LauncherSnapshot | undefined;
  let disposed = false;
  const text = (key: MessageKey) => t(options.locale(), key);
  const refresh = () => {
    if (!disposed) options.render();
  };
  return {
    async load() {
      if (!options.platform.authenticatedLaunch) return;
      await Promise.allSettled([
        options.platform.readLayout().then((value) => {
          snapshot = value;
          refresh();
        }),
      ]);
    },
    dispose() {
      disposed = true;
    },
    opened(id: string) {
      if (options.platform.authenticatedLaunch)
        void options.platform.recordOpen(id).catch(() => {});
    },
    content(items: LauncherItem[]) {
      const layout = snapshot?.layout ?? emptyLayout();
      const ordered = [...items]
        .sort((a, b) => {
          const rank = (id: string) => {
            const pinned = layout.pinned.indexOf(id);
            if (pinned >= 0) return pinned - layout.pinned.length;
            const at = layout.order.indexOf(id);
            return at < 0 ? Infinity : at;
          };
          return rank(a.id) - rank(b.id);
        })
        .map((item) => ({
          ...item,
          favourite: layout.favourites.includes(item.id),
          inFolder:
            !layout.pinned.includes(item.id) &&
            layout.folders.some((folder) => folder.apps.includes(item.id)),
        }));
      const external: LauncherItem = {
        id: "external:cryptonos",
        name: text("launcher.cryptonos"),
        group: "apps",
        tier: "community",
        tierLabel: text("launcher.separate"),
        onOpen: () => {
          options.platform.openCryptoNos();
        },
      };
      const root = Group();
      root.classList.add("rada-desktop");
      const arrange = () => {
        void (async () => {
          try {
            snapshot ??= await options.platform.readLayout();
            const { editLauncher } = await loadEditor();
            if (disposed || options.navigation.top.key !== "launcher") return;
            editLauncher({
              locale: options.locale(),
              navigation: options.navigation,
              snapshot,
              apps: ordered,
              save: options.platform.saveLayout,
              reload: options.platform.readLayout,
              updated(value) {
                snapshot = value;
                refresh();
              },
            });
          } catch {
            root.append(
              ErrorState({
                message: text("shell.unavailableDescription"),
                retryLabel: text("common.retry"),
                onRetry: refresh,
              }),
            );
          }
        })();
      };
      root.append(
        LauncherBrowser({
          items: [...ordered, external],
          state: browserState,
          label: text("home.gridLabel"),
          searchLabel: text("launcher.search"),
          emptyLabel: text("launcher.empty"),
          count: (count) =>
            t(options.locale(), "launcher.count", { count: String(count) }),
          groups: ["rada", "games", "apps", "favourites"].map((id) => ({
            id,
            label: text(`launcher.${id}` as MessageKey),
          })),
          folders: layout.folders,
          openFolder(title, tiles) {
            void loadEditor()
              .then(({ openLauncherFolder }) => {
                if (
                  disposed ||
                  !root.isConnected ||
                  options.navigation.top.key !== "launcher"
                )
                  return;
                openLauncherFolder({
                  title,
                  tiles,
                  locale: options.locale(),
                  navigation: options.navigation,
                });
              })
              .catch(() => {
                root.append(
                  ErrorState({
                    message: text("shell.unavailableDescription"),
                    retryLabel: text("common.retry"),
                    onRetry: refresh,
                  }),
                );
              });
          },
          ...(options.platform.authenticatedLaunch
            ? { arrange, arrangeLabel: text("launcher.edit") }
            : {}),
        }),
      );
      return root;
    },
  };
}
