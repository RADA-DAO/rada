import { createChunkLoader } from "./chunk-loader.ts";
import {
  AppGrid,
  AppTile,
  Button,
  Group,
  LauncherBrowser,
  openSheet,
  Section,
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
  type LauncherActivity,
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
  let activity: LauncherActivity = { recent: [], popular: [] };
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
        options.platform.readActivity().then((value) => {
          activity = value;
          refresh();
        }),
      ]);
    },
    dispose() {
      disposed = true;
    },
    opened(id: string) {
      if (options.platform.authenticatedLaunch)
        void options.platform
          .recordOpen(id)
          .then((value) => {
            activity = value;
          })
          .catch(() => {});
    },
    content(items: LauncherItem[]) {
      const layout = snapshot?.layout ?? emptyLayout();
      const ordered = [...items]
        .sort((a, b) => {
          const rank = (id: string) => {
            const at = layout.order.indexOf(id);
            return at < 0 ? Infinity : at;
          };
          return rank(a.id) - rank(b.id);
        })
        .map((item) => ({
          ...item,
          favourite: layout.favourites.includes(item.id),
          inFolder: layout.folders.some((folder) =>
            folder.apps.includes(item.id),
          ),
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
      const grid = (ids: string[], title: string, contextual = true) =>
        Section({
          title,
          children: [
            AppGrid({
              label: title,
              tiles: ids.flatMap((id) => {
                const item = ordered.find((a) => a.id === id);
                if (!item) return [];
                const tile = AppTile(item);
                if (contextual) {
                  tile.removeAttribute("aria-labelledby");
                  tile.setAttribute("aria-label", `${title}: ${item.name}`);
                }
                return [tile];
              }),
            }),
          ],
        });
      const inOrder = (ids: string[]) =>
        ordered.filter((item) => ids.includes(item.id)).map((item) => item.id);
      const root = Group();
      const folders = layout.folders.map((folder) =>
        AppTile({
          name: folder.name,
          tier: "platform",
          onOpen() {
            openSheet({
              title: folder.name,
              closeLabel: text("common.close"),
              navigation: options.navigation,
              children: [grid(inOrder(folder.apps), folder.name, false)],
            });
          },
        }),
      );
      if (folders.length)
        root.append(AppGrid({ label: text("launcher.root"), tiles: folders }));
      if (layout.pinned.some((id) => ordered.some((a) => a.id === id)))
        root.append(grid(inOrder(layout.pinned), text("launcher.pinned")));
      root.append(
        LauncherBrowser({
          items: [...ordered, external],
          state: browserState,
          label: text("home.gridLabel"),
          searchLabel: text("launcher.search"),
          emptyLabel: text("launcher.empty"),
          count: (count) =>
            t(options.locale(), "launcher.count", { count: String(count) }),
          groups: ["all", "rada", "games", "apps", "favourites"].map((id) => ({
            id,
            label: text(`launcher.${id}` as MessageKey),
          })),
        }),
      );
      if (activity.recent.some((id) => ordered.some((a) => a.id === id)))
        root.append(grid(activity.recent, text("launcher.recent")));
      if (activity.popular.some((p) => ordered.some((a) => a.id === p.appId)))
        root.append(
          grid(
            activity.popular.map((p) => p.appId),
            text("launcher.popular"),
          ),
        );
      if (options.platform.authenticatedLaunch)
        root.append(
          Button(text("launcher.edit"), {
            onClick: () => {
              void (async () => {
                try {
                  snapshot ??= await options.platform.readLayout();
                  const { editLauncher } = await loadEditor();
                  if (disposed || options.navigation.top.key !== "launcher")
                    return;
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
            },
          }),
        );
      return root;
    },
  };
}
