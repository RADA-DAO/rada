import test from "node:test";
import assert from "node:assert/strict";
import {
  codeSizeViolations,
  designSystemViolations,
  moduleImportViolations,
  moduleSqlViolations,
  missingHistoricalMigrations,
  publicSqlViews,
} from "./architecture.mjs";

await test("code size gate covers executable files and only exempts test/generated paths", () => {
  const lines = "statement;\n".repeat(401);
  assert.equal(
    codeSizeViolations("modules/apps/api/store.ts", lines).length,
    1,
  );
  assert.equal(codeSizeViolations("apps/miniapp/src/main.ts", lines).length, 1);
  assert.equal(
    codeSizeViolations("apps/miniapp/src/main.ts", "x\n".repeat(400)).length,
    0,
  );
  for (const path of [
    "tools/check.test.mjs",
    "modules/apps/db/apps.test.sql",
    "packages/ui/scripts/test-theme.ts",
    "modules/apps/generated/client.ts",
  ])
    assert.deepEqual(codeSizeViolations(path, lines), []);
  assert.equal(
    codeSizeViolations("modules/apps/api/client.ts", "// generated\n" + lines)
      .length,
    1,
  );
});

await test("foreign views require an owned definition exported by the module index", () => {
  const sources = new Map([
    [
      "modules/identity/index.ts",
      'export const SQL_PUBLIC_VIEWS = ["identity.public_profile"] as const;',
    ],
    [
      "modules/identity/db/migrations/0004_view.sql",
      "CREATE VIEW identity.public_profile AS SELECT subject_id FROM identity.subjects;",
    ],
  ]);
  const views = publicSqlViews(sources);
  assert.deepEqual(
    moduleSqlViolations(
      "modules/apps/db/new.sql",
      "SELECT * FROM identity.public_profile",
      views,
    ),
    [],
  );
  assert.ok(
    moduleSqlViolations(
      "modules/apps/db/new.sql",
      "SELECT * FROM identity.subjects",
      views,
    ).length,
  );
  sources.delete("modules/identity/db/migrations/0004_view.sql");
  assert.throws(() => publicSqlViews(sources), /no owned view definition/);
  sources.set(
    "modules/identity/index.ts",
    'export const SQL_PUBLIC_VIEWS = ["apps.registry"] as const;',
  );
  assert.throws(() => publicSqlViews(sources), /belong to their module/);
});

await test("cross-module imports require public index for static, re-export and dynamic paths", () => {
  for (const source of [
    'import { x } from "../../jpegpe/api/store.ts";',
    'export { x } from "../../jpegpe/api/store.ts";',
    'const x = import("../../jpegpe/api/store.ts");',
    'const x = require("../../jpegpe/api/store.ts");',
    'type X = import("../../jpegpe/api/store.ts").X;',
    'import x = require("../../jpegpe/api/store.ts");',
    "const x = import(variable);",
  ])
    assert.ok(
      moduleImportViolations("modules/identity/api/store.ts", source).length,
      source,
    );
  assert.ok(
    moduleImportViolations(
      "apps/api/src/app.ts",
      'import "../../../modules/identity/api/store.ts";',
    ).length,
  );
  for (const source of [
    'import { x } from "../../jpegpe/index.ts";',
    'import { x } from "./private.ts";',
    'import pg from "pg";',
  ])
    assert.deepEqual(
      moduleImportViolations("modules/identity/api/store.ts", source),
      [],
    );
  assert.ok(
    moduleImportViolations(
      "modules/identity/api/store.ts",
      'import x from "@rada/jpegpe/private";',
    ).length,
  );
});

await test("SQL boundary rejects foreign table queries including quoted names and embedded SQL", () => {
  assert.ok(
    moduleSqlViolations(
      "apps/api/src/app.ts",
      'const q = "SELECT * FROM identity.subjects";',
    ).length,
  );
  assert.ok(
    moduleImportViolations(
      "modules/identity/api/router.ts",
      'import "../../../apps/api/src/app.ts";',
    ).length,
  );
  for (const sql of [
    "SELECT * FROM identity.subjects",
    'UPDATE "identity"."subjects" SET selected_frog_id = NULL',
    "INSERT INTO identity.subjects SELECT * FROM apps.registry",
    "DELETE FROM identity.consents",
    "SELECT * FROM apps.registry JOIN identity.subjects USING(subject_id)",
    "TRUNCATE TABLE identity.subjects",
    "GRANT SELECT ON identity.subjects TO apps_service",
    "CREATE INDEX foreign_lookup ON identity.subjects(subject_id)",
    "CREATE TABLE apps.links(subject_id uuid REFERENCES identity.subjects(subject_id))",
  ])
    assert.ok(moduleSqlViolations("modules/apps/db/new.sql", sql).length, sql);
  assert.ok(
    moduleSqlViolations(
      "modules/apps/api/store.ts",
      "const query = `SELECT * FROM identity.subjects WHERE subject_id = ${id}`;",
    ).length,
  );
  assert.deepEqual(
    moduleSqlViolations(
      "modules/apps/db/new.sql",
      "SELECT apps.published(); SELECT * FROM identity.public_profile($1); -- FROM identity.subjects\n SELECT * FROM apps.registry;",
    ),
    [],
  );
  assert.deepEqual(
    moduleSqlViolations(
      "modules/apps/db/apps.test.sql",
      "SELECT * FROM identity.subjects",
    ),
    [],
  );
  assert.ok(
    moduleSqlViolations(
      "modules/identity/db/migrations/0001_identity.sql",
      "changed",
    ).length,
  );
  assert.equal(missingHistoricalMigrations([]).length, 3);
});

await test("public UI entrypoints are exact and preserve module alias boundaries", () => {
  for (const entry of ["@rada/ui", "@rada/ui/design-system.css"])
    assert.deepEqual(
      moduleImportViolations(
        "modules/profile/ui/view.ts",
        `import "${entry}";`,
      ),
      [],
    );
  for (const entry of [
    "@rada/ui/private",
    "@rada/ui/../secret",
    "@rada/ui/design-system.css?inline",
    "@rada/identity",
  ])
    assert.ok(
      moduleImportViolations("modules/profile/ui/view.ts", `import "${entry}";`)
        .length,
    );
});

await test("design gate rejects raw styles and foreign CSS through each import form", () => {
  for (const source of [
    'const color = "#abc";',
    'const color = "#abcd";',
    'const color = "#12345678";',
    'const style = {padding: "var(--space-4)", background: "#abcd"};',
    'node.style.background = "linear-gradient(45deg, #abcd, #12345678)";',
    "const css = `background: ${color}`;",
    "const css = `.x { background: ${color}; }`;",
    "node.innerHTML = `<style>${css}</style>`;",
    'const color = "rgb(1 2 3)";',
    'const color = "hsl(2 3% 4%)";',
    'node.style.boxShadow = "0 0 #fff";',
    'const css = ".x { color: red; }";',
    `const css = '@import "foreign.css";';`,
    'import("data:text/css,.x{}");',
    'node.style.margin = "12px";',
    'const space = "1rem";',
    "const style = { fontSize: 18, padding: 8 };",
    '<p style={{margin: "2em", color: "#abcdef"}} />;',
    'node.style["fontSize"] = 16;',
    'node.style.setProperty("padding", "2rem");',
    'node.setAttribute("style", "color: red");',
    "node.style.cssText = css;",
    'document.createElement("style");',
    "<style>{css}</style>;",
    "const sheet = new CSSStyleSheet();",
    "sheet.insertRule(rule);",
    "const styles = css`.x { margin: 1rem; }`;",
    'import "./local.css";',
    'export * from "third-party/theme.css";',
    'import("./local.css?inline");',
    'require("./local.css");',
    'import styles = require("./local.css");',
    'import "@rada/ui/design-system.css?inline";',
  ])
    assert.ok(
      designSystemViolations("apps/miniapp/src/view.tsx", source).length,
      source,
    );
  assert.ok(
    designSystemViolations(
      "modules/profile/ui/local.css",
      ".x { color: var(--color-text); }",
    ).length,
  );
  for (const source of [
    "<style>.x{color:red}</style>",
    '<div style="color:red"></div>',
    '<link rel="stylesheet" href="local.css">',
  ])
    assert.ok(
      designSystemViolations("apps/miniapp/index.html", source).length,
      source,
    );
});

await test("design gate locates gesture handlers and history calls in syntax", () => {
  for (const source of [
    'node.addEventListener("touchstart", handler);',
    'node["addEventListener"]("pointerdown", handler);',
    "node.ontouchstart = handler;",
    'node["onpointerdown"] = handler;',
    'node.setAttribute("ontouchstart", handler);',
    "<div onTouchStart={handler} />;",
    "<div onPointerDown={handler} />;",
    'const props = { ["onSwipeRight"]: handler };',
    "const props = { onTouchStart() {} };",
    "history.back();",
    "window.history.back();",
    'globalThis["history"]["back"]();',
    "self.history.back();",
  ])
    assert.ok(
      designSystemViolations("modules/profile/ui/view.tsx", source).length,
      source,
    );
});

await test("design gate rejects elements that duplicate a platform component", () => {
  for (const source of [
    'document.createElement("button");',
    'document.createElement("dialog");',
    "document[`createElement`]('input');",
    'const nav = doc.createElement("NAV");',
    'node.ownerDocument.createElement("h1");',
  ])
    assert.ok(
      designSystemViolations("apps/miniapp/src/view.ts", source).length,
      source,
    );
  for (const source of [
    'document.createElement("div");',
    'document.createElement("iframe");',
    'document.createElement("canvas");',
    'const tag = "button"; document.createElement(tag);',
  ])
    assert.deepEqual(
      designSystemViolations("modules/game/ui/view.ts", source),
      [],
      source,
    );
  for (const path of [
    "packages/ui/src/button.ts",
    "packages/platform-sdk/src/payment-window.ts",
    "apps/miniapp/tests/view.spec.ts",
  ])
    assert.deepEqual(
      designSystemViolations(path, 'document.createElement("button");'),
      [],
    );
});

await test("design gate permits tokens, domain data and existing exemption locations", () => {
  const good = `
    import "@rada/ui/design-system.css";
    const color = "var(--color-text)";
    node.style.padding = "var(--space-4)";
    node.style.display = "none";
    node.hidden = true;
    const style = { fontSize: typography.body, padding: 0 };
    const url = "https://example.org/page#abcdef";
    const sql = "SELECT '#abcdef' AS id";
    const protocol = "CHROMATIC_RED";
    const description = "A document discussing 12px text";
    const message = "history.back() touchstart #abcdef";
    const business = { history: { back() {} } }; business.history.back();
    node.addEventListener("click", handler);
    // node.addEventListener("touchstart", handler); color = "#fff";
  `;
  assert.deepEqual(
    designSystemViolations("modules/profile/ui/view.ts", good),
    [],
  );
  for (const path of [
    "packages/ui/src/view.ts",
    "packages/platform-sdk/src/navigation.ts",
    "apps/miniapp/tests/view.ts",
    "modules/jpegpe/color-protocol/test.ts",
    "modules/profile/fixtures/view.ts",
    "apps/miniapp/generated/view.ts",
    "modules/profile/ui/view.test.ts",
  ])
    assert.deepEqual(
      designSystemViolations(path, 'const c = "#fff"; history.back();'),
      [],
    );
});

await test("design gate checks rendered markup, inline scripts and named style palettes", () => {
  for (const source of [
    `node.innerHTML = '<div style="color:red">x</div>';`,
    'node.innerHTML = `<div style="color:${color}">x</div>`;',
    `node.outerHTML = '<div onTouchStart="swipe()">x</div>';`,
    'node.innerHTML = `<div onpointerdown="${handler}">x</div>`;',
    `node.insertAdjacentHTML("beforeend", '<div style="color:red"></div>');`,
    'node.style.color = "red";',
    'node.style.backgroundColor = "blue";',
    'node.style["fill"] = "gold";',
    'node.style.stroke = "rebeccapurple";',
    'node.style.setProperty("background-color", "red");',
    '<div style={{color: "red"}} />;',
    'const style = {backgroundColor: "red"};',
  ])
    assert.ok(
      designSystemViolations("apps/miniapp/src/view.tsx", source).length,
      source,
    );
  for (const html of [
    "<script>history.back()</script>",
    '<script type="module">window.addEventListener("pointerdown", handler)</script>',
    '<script type="text/javascript">globalThis.history.back()</script>',
  ])
    assert.ok(
      designSystemViolations("apps/miniapp/index.html", html).length,
      html,
    );
  for (const html of [
    '<script type="application/json">{"example":"history.back()"}</script>',
    '<script type="application/ld+json">{"event":"pointerdown"}</script>',
    '<p>The style="color:red" example appears in documentation.</p>',
    '<!-- <div style="color:red"></div> --><p>Example</p>',
  ])
    assert.deepEqual(
      designSystemViolations("apps/miniapp/index.html", html),
      [],
      html,
    );
  assert.deepEqual(
    designSystemViolations(
      "apps/miniapp/src/view.tsx",
      `
    node.innerHTML = "<p>Ordinary markup</p>";
    const prose = 'The style="color:red" example';
    const metadata = { color: "red", backgroundColor: "blue" };
    node.style.display = "none";
    node.style.color = "transparent";
    node.style.backgroundColor = "var(--color-surface)";
    node.style.fill = "currentColor";
    node.style.stroke = "none";
    const style = { color: "inherit", backgroundColor: "unset" };
  `,
    ),
    [],
  );
});
