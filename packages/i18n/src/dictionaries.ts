import enCollection from "../locales/en.collection.json" with { type: "json" };
import ukCollection from "../locales/uk.collection.json" with { type: "json" };
import enBase from "../locales/en.json" with { type: "json" };
import ukBase from "../locales/uk.json" with { type: "json" };
import enSplash from "../locales/en.splash.json" with { type: "json" };
import ukSplash from "../locales/uk.splash.json" with { type: "json" };

export const en = { ...enBase, collection: enCollection, splash: enSplash };
export const uk = { ...ukBase, collection: ukCollection, splash: ukSplash };
