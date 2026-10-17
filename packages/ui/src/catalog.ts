// Development and test pages only: vite.config.ts adds this entry when CATALOG=true.
// Every component in every variant and state, with fixed data, for visual tests.
import "./design-system.css";
import {
  Actions,
  AppGrid,
  AppTile,
  applyTheme,
  Avatar,
  Button,
  Card,
  compileTheme,
  DEFAULT_THEME_BACKGROUND,
  EmptyState,
  ErrorState,
  Field,
  FrogCard,
  Group,
  Identity,
  List,
  ListItem,
  Loading,
  openSheet,
  Screen,
  ScreenHost,
  Section,
  Tabs,
  Text,
} from "./index.ts";
import { t, type MessageKey } from "../../i18n/src/index.ts";
import { mediaSection } from "./catalog-media.ts";

/** Fixed themes: the guest palette plus one light and one dark profile. */
const themes = {
  guest: () => compileTheme(DEFAULT_THEME_BACKGROUND),
  light: () => compileTheme("#E8EEF2", "#2B6CB0"),
  dark: () => compileTheme("#1B2A4A", "#F2C94C"),
  neutral: () => compileTheme("#E5E5E5"),
  close: () => compileTheme("#344C40", "#385544"),
};
type ThemeName = keyof typeof themes;

/** Content-addressed path the frog card accepts; tests answer it with a fixed image. */
const CATALOG_ARTWORK_PATH = `/media/jpegpe/${"a".repeat(64)}.png`;
const AVATAR_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='#7a5cff'/><circle cx='20' cy='20' r='9' fill='#ffd166'/></svg>",
)}`;

const APP_ICON_IMAGE = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#2b8a6e'/><path d='M14 44 32 14l18 30z' fill='#f4f1de'/></svg>",
)}`;

const text = (key: string) => t("en", `catalog.${key}` as MessageKey);

const params = new URLSearchParams(location.search);
const requested = params.get("theme");
const themeName: ThemeName =
  requested && Object.hasOwn(themes, requested)
    ? (requested as ThemeName)
    : "guest";
applyTheme(document.documentElement, themes[themeName]());

const noop = () => undefined;

function buttons(): Node {
  const variants = ["primary", "secondary", "ghost"] as const;
  const rows = variants.map((variant) =>
    Actions([
      Button(text(variant), { variant }),
      Button(text("loading"), { variant, loading: true }),
      Button(text("disabled"), { variant, disabled: true }),
    ]),
  );
  return Section({ title: text("buttons"), children: rows });
}

function fields(): Node {
  const plain = Field({ label: text("fieldText"), value: text("fieldValue") });
  const invalid = Field({
    label: text("fieldErrorLabel"),
    value: text("fieldErrorValue"),
    error: text("fieldError"),
  });
  const note = Field({
    label: text("fieldNote"),
    kind: "textarea",
    rows: 3,
    value: text("fieldNoteValue"),
  });
  const choice = Field({
    label: text("fieldChoice"),
    kind: "select",
    value: "uk",
    choices: [
      { value: "en", label: text("choiceEn") },
      { value: "uk", label: text("choiceUk") },
    ],
  });
  return Section({
    title: text("fields"),
    children: [plain.element, invalid.element, note.element, choice.element],
  });
}

function states(): Node {
  return Section({
    title: text("states"),
    children: [
      Loading({ message: text("stateLoading") }),
      EmptyState({
        title: text("stateEmptyTitle"),
        message: text("stateEmpty"),
      }),
      ErrorState({
        title: text("stateErrorTitle"),
        message: text("stateError"),
        retryLabel: text("stateRetry"),
        onRetry: noop,
      }),
    ],
  });
}

function avatars(): Node {
  return Section({
    title: text("avatars"),
    children: [
      Actions([
        Avatar({
          name: "Frog Fixture",
          imageUrl: AVATAR_IMAGE,
          label: text("avatarImage"),
        }),
        Avatar({ name: "Frog Fixture", label: text("avatarInitials") }),
        Avatar({
          name: "Frog Fixture",
          size: "small",
          label: text("avatarSmall"),
        }),
      ]),
    ],
  });
}

function lists(): Node {
  const list = List({
    label: text("listLabel"),
    children: [
      ListItem({
        title: text("itemTitle"),
        description: text("itemText"),
        leading: Avatar({ name: "First Fixture" }),
        actions: [Button(text("itemAction"), { variant: "primary" })],
      }),
      ListItem({
        title: text("itemSecond"),
        heading: true,
        description: text("itemText"),
      }),
    ],
  });
  const marked = List({
    marked: true,
    children: [
      ListItem({ title: text("markedOne") }),
      ListItem({ title: text("markedTwo") }),
    ],
  });
  return Section({
    title: text("lists"),
    children: [
      list,
      marked,
      Card({ children: [Text(text("cardText"))] }),
      Section({
        title: text("sectionTitle"),
        children: [Text(text("cardText"))],
      }),
    ],
  });
}

function launcher(): Node {
  const tier = (key: "official" | "community") => t("en", `home.tier.${key}`);
  const tiles = [
    AppTile({
      name: text("appGovernance"),
      tier: "official",
      tierLabel: tier("official"),
      onOpen: noop,
    }),
    AppTile({
      name: text("appTreasury"),
      tier: "official",
      tierLabel: tier("official"),
      onOpen: noop,
    }),
    AppTile({ name: text("appWallet"), tier: "platform", onOpen: noop }),
    AppTile({
      name: text("appGame"),
      tier: "community",
      tierLabel: tier("community"),
      onOpen: noop,
    }),
    AppTile({
      name: text("appIcon"),
      tier: "community",
      tierLabel: tier("community"),
      iconUrl: APP_ICON_IMAGE,
      onOpen: noop,
    }),
    AppTile({
      name: text("appDisabled"),
      tier: "community",
      tierLabel: tier("community"),
      onOpen: noop,
      disabled: true,
    }),
  ];
  return Section({
    title: text("launcher"),
    children: [
      Identity({
        name: text("identityName"),
        caption: text("identityCaption"),
        imageUrl: AVATAR_IMAGE,
      }),
      AppGrid({ label: text("gridLabel"), tiles }),
    ],
  });
}

function frogCards(): Node {
  const art = { url: CATALOG_ARTWORK_PATH, alt: text("frogArt") };
  const options = { missingArtLabel: text("frogMissing") };
  const model = {
    username: "@frog_fixture",
    background_color: "#1B5E4B",
    accent_color: "#F2C94C",
  };
  return Section({
    title: text("frogCards"),
    children: [
      Group([FrogCard(model, { ...options, image: art })]),
      Group([
        FrogCard(
          {
            username: "@plain",
            background_color: "#C9B8E8",
            accent_color: null,
          },
          options,
        ),
      ]),
    ],
  });
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing application root");
ScreenHost(root).append(
  Screen({
    title: text("title"),
    brand: text("brand"),
    actions: [Button(text("settings"), { variant: "ghost", icon: "settings" })],
    children: [
      buttons(),
      fields(),
      states(),
      avatars(),
      launcher(),
      lists(),
      frogCards(),
      mediaSection(),
    ],
    footer: Tabs({
      label: text("tabsLabel"),
      selected: "profile",
      tabs: [
        { id: "apps", label: text("tabApps"), onSelect: noop },
        { id: "profile", label: text("tabProfile"), onSelect: noop },
      ],
    }),
  }),
);

if (params.get("sheet") === "open")
  openSheet({
    title: text("sheetTitle"),
    closeLabel: text("sheetClose"),
    children: [
      Text(text("sheetText")),
      Actions([Button(text("sheetAction"), { variant: "primary" })]),
    ],
  });

document.documentElement.dataset.catalogReady = "true";
