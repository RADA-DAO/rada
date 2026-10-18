import { LauncherBrowser, ReorderItem, Text } from "./index.ts";
import { t } from "../../i18n/src/index.ts";
const noop = () => {};
export const launcherCatalog = () => [
  LauncherBrowser({
    items: [
      {
        id: "catalog",
        name: t("en", "launcher.games"),
        group: "games",
        tier: "community",
        tierLabel: t("en", "home.tier.community"),
        onOpen: noop,
      },
    ],
    label: t("en", "home.gridLabel"),
    searchLabel: t("en", "launcher.search"),
    emptyLabel: t("en", "launcher.empty"),
    count: (count) => t("en", "launcher.count", { count: String(count) }),
    groups: [
      { id: "all", label: t("en", "launcher.all") },
      { id: "rada", label: t("en", "launcher.rada") },
      { id: "games", label: t("en", "launcher.games") },
      { id: "apps", label: t("en", "launcher.apps") },
      { id: "favourites", label: t("en", "launcher.favourites") },
    ],
  }),
  ReorderItem({
    child: Text(t("en", "launcher.games")),
    name: t("en", "launcher.games"),
    earlier: t("en", "launcher.up"),
    later: t("en", "launcher.down"),
    first: true,
    last: false,
    move: noop,
  }),
];
