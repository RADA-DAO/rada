import enBase from "../locales/en.json" with { type: "json" };
import ukBase from "../locales/uk.json" with { type: "json" };
import enSplash from "../locales/en.splash.json" with { type: "json" };
import ukSplash from "../locales/uk.splash.json" with { type: "json" };

export const en = { ...enBase, splash: enSplash };
export const uk = { ...ukBase, splash: ukSplash };
