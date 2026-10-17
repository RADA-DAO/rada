import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathAllowed, conventional, uiViolations } from "./check.mjs";
import "./architecture.test.mjs";
import "../packages/platform-sdk/src/rankings.test.ts";
import "./staging-config.test.mjs";
import "../packages/ui/scripts/test-theme-compiler.ts";
import "../packages/ui/scripts/test-components.ts";
import "../packages/ui/scripts/test-launcher.ts";
import "../packages/ui/scripts/test-guest-palette.ts";
import "../packages/i18n/scripts/test-keys.ts";

await test("i18n keys, interpolation, locale parity, and plural categories", () => {
  execFileSync(process.execPath, ["packages/i18n/scripts/test-i18n.mjs"]);
});

await test("hygiene rejects accidental notes and unsupported locations", () => {
  assert.equal(pathAllowed("docs/architecture/README.md"), true);
  for (const path of [
    "NOTES.md",
    "docs/notes/private.md",
    "docs/adr/2026-10-15-choice.md",
    "apps/api/debug.log",
  ])
    assert.equal(pathAllowed(path), false);
});
await test("commit gate accepts conventional titles and rejects ordinary prose", () => {
  assert.equal(conventional("chore: initialize scaffold"), true);
  assert.equal(conventional("feat(api)!: change interface"), true);
  assert.equal(conventional("update stuff"), false);
});
await test("UI gate catches text and allows translation keys and locale data", () => {
  assert.ok(uiViolations("apps/miniapp/view.tsx", "<p>Hello</p>").length);
  assert.ok(
    uiViolations("apps/miniapp/view.tsx", '<input placeholder="Name" />')
      .length,
  );
  assert.ok(
    uiViolations("apps/miniapp/view.tsx", 'node.textContent = "Hello";').length,
  );
  assert.ok(
    uiViolations(
      "apps/miniapp/view.tsx",
      'node.setAttribute("aria-label", "Save");',
    ).length,
  );
  assert.ok(
    uiViolations(
      "apps/miniapp/view.tsx",
      'const label = "Hello"; node.textContent = label;',
    ).length,
  );
  assert.ok(uiViolations("apps/miniapp/view.tsx", 'Button("Hello");').length);
  assert.ok(
    uiViolations(
      "apps/miniapp/view.tsx",
      'const label = "Hello"; <Button aria-label={label} />',
    ).length,
  );
  assert.ok(
    uiViolations("apps/miniapp/view.tsx", 'Sheet({ title: "Hello" });').length,
  );
  assert.deepEqual(
    uiViolations("apps/miniapp/view.tsx", '<p>{t("profile.name")}</p>'),
    [],
  );
  assert.deepEqual(uiViolations("packages/i18n/locales/uk.json", "{}"), []);
  assert.deepEqual(
    uiViolations(
      "packages/ui/src/view.ts",
      'document.createElement("button"); const color = "#ffffff"; const mode = "submit";',
    ),
    [],
  );
  assert.deepEqual(
    uiViolations(
      "apps/miniapp/view.tsx",
      '<div className={"card"} data-mode={"compact"} role={"status"} />',
    ),
    [],
  );
  assert.deepEqual(
    uiViolations(
      "packages/ui/src/view.ts",
      'Sheet({ "title": t("state.empty") });',
    ),
    [],
  );
});
