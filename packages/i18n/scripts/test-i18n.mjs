import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { t } from "../src/index.ts";

const en = JSON.parse(
  await readFile(new URL("../locales/en.json", import.meta.url)),
);
const uk = JSON.parse(
  await readFile(new URL("../locales/uk.json", import.meta.url)),
);
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
    else if (child && typeof child === "object") flatten(child, path, result);
  }
  return result;
}
assert.deepEqual(
  Object.keys(flatten(en)).sort(),
  Object.keys(flatten(uk)).sort(),
);
assert.ok(Object.keys(flatten(en)).includes("common.close"));
const incomplete = structuredClone(uk);
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
