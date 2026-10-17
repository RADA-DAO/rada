import enApps from "../locales/en.apps.json" with { type: "json" };
import ukApps from "../locales/uk.apps.json" with { type: "json" };
import enTreasury from "../locales/en.treasury.json" with { type: "json" };
import ukTreasury from "../locales/uk.treasury.json" with { type: "json" };
import enCollection from "../locales/en.collection.json" with { type: "json" };
import ukCollection from "../locales/uk.collection.json" with { type: "json" };
import enNotifications from "../locales/en.notifications.json" with { type: "json" };
import ukNotifications from "../locales/uk.notifications.json" with { type: "json" };
import enBase from "../locales/en.json" with { type: "json" };
import ukBase from "../locales/uk.json" with { type: "json" };
import enSplash from "../locales/en.splash.json" with { type: "json" };
import ukSplash from "../locales/uk.splash.json" with { type: "json" };

export const en = {
  ...enBase,
  appReport: enApps,
  treasury: enTreasury,
  collection: enCollection,
  splash: enSplash,
  notifications: enNotifications,
};
export const uk = {
  ...ukBase,
  appReport: ukApps,
  treasury: ukTreasury,
  collection: ukCollection,
  splash: ukSplash,
  notifications: ukNotifications,
};
