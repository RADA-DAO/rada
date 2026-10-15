import assert from "node:assert/strict";
import { t } from "../src/index.ts";

import en from "../locales/en.json" with { type: "json" };
import uk from "../locales/uk.json" with { type: "json" };

/** @param {Record<string, unknown>} value @param {string} prefix @param {Record<string, unknown>} result */
function flatten(value, prefix = "", result = {}) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result[path] = child;
    else if (
      child &&
      typeof child === "object" &&
      "other" in child &&
      Object.values(child).every((form) => typeof form === "string")
    )
      result[path] = child;
    else if (child && typeof child === "object")
      flatten(/** @type {Record<string, unknown>} */ (child), path, result);
  }
  return result;
}
assert.deepEqual(
  Object.keys(flatten(en)).sort(),
  Object.keys(flatten(uk)).sort(),
);
assert.ok(Object.keys(flatten(en)).includes("common.close"));
/** @type {Partial<typeof uk.common>} */
const incompleteCommon = structuredClone(uk.common);
const incomplete = { ...uk, common: incompleteCommon };
delete incomplete.common.close;
assert.notDeepEqual(
  Object.keys(flatten(en)).sort(),
  Object.keys(flatten(incomplete)).sort(),
);
assert.equal(t("en", "state.items", { count: 1 }), "1 item");
assert.equal(t("en", "state.items", { count: 5 }), "5 items");
assert.equal(
  t("uk", "state.items", { count: 1 }),
  uk.state.items.one.replace("{{count}}", "1"),
);
assert.equal(
  t("uk", "state.items", { count: 2 }),
  uk.state.items.few.replace("{{count}}", "2"),
);
assert.equal(
  t("uk", "state.items", { count: 5 }),
  uk.state.items.many.replace("{{count}}", "5"),
);
assert.equal(t("uk", "common.retry"), uk.common.retry);
