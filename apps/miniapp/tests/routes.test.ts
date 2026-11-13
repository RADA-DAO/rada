import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

// The browser shell imports CSS alongside its controllers; route checks need no DOM.
register(
  `data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`,
  import.meta.url,
);
const { createRoutes } = await import("../src/routes.ts");

const hidden = [
  "community",
  "review",
  "holders",
  "governance",
  "governance-settings",
  "governance-proposal",
];

void test("release navigation rejects hidden direct pushes and replacements", () => {
  const routes = createRoutes();
  try {
    for (const key of hidden) {
      routes.navigation.push({ key });
      assert.deepEqual(routes.navigation.keys, ["launcher"]);
      routes.navigation.replace({ key });
      assert.equal(routes.current(), "launcher");
      assert.equal(routes.navigation.top.key, "launcher");
    }
    for (const key of ["community", "review", "holders"] as const) {
      routes.open(key);
      assert.equal(routes.current(), "launcher");
    }
    routes.open("profile");
    routes.navigation.push({ key: "settings" });
    assert.equal(routes.current(), "profile");
    routes.navigation.back();
    routes.open("collection");
    assert.equal(routes.current(), "collection");
    routes.openFrog("synthetic-frog");
    assert.equal(routes.frogId(), "synthetic-frog");
    assert.equal(routes.current(), "frog");
  } finally {
    routes.navigation.dispose();
  }
});

void test("a treasury decision is reachable only while treasury remains an ancestor", () => {
  const routes = createRoutes(false);
  try {
    routes.navigation.push({ key: "treasury" });
    routes.navigation.replace({ key: "governance-proposal" });
    assert.equal(
      routes.current(),
      "treasury",
      "replacing treasury cannot grant ancestry",
    );
    routes.navigation.push({ key: "governance-proposal" });
    assert.equal(routes.current(), "governance-proposal");
    routes.navigation.push({ key: "governance" });
    assert.equal(routes.current(), "governance-proposal");
    routes.navigation.back();
    assert.equal(routes.current(), "treasury");
    routes.navigation.back();
    routes.navigation.push({ key: "governance-proposal" });
    assert.equal(routes.current(), "launcher");
  } finally {
    routes.navigation.dispose();
  }
});

void test("explicit developer surface retains the complete route set", () => {
  const routes = createRoutes(true);
  try {
    for (const key of hidden) {
      routes.navigation.push({ key });
      assert.equal(routes.current(), key);
    }
    routes.navigation.replace({ key: "governance-settings" });
    assert.equal(routes.current(), "governance-settings");
  } finally {
    routes.navigation.dispose();
  }
});
