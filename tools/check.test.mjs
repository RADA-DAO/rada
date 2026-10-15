import test from "node:test";
import assert from "node:assert/strict";
import { pathAllowed, conventional, uiViolations } from "./check.mjs";

test("hygiene rejects accidental notes and unsupported locations", () => {
  assert.equal(pathAllowed("docs/architecture/README.md"), true);
  for (const path of [
    "NOTES.md",
    "docs/notes/private.md",
    "docs/adr/2026-10-15-choice.md",
    "apps/api/debug.log",
  ])
    assert.equal(pathAllowed(path), false);
});
test("commit gate accepts conventional titles and rejects ordinary prose", () => {
  assert.equal(conventional("chore: initialize scaffold"), true);
  assert.equal(conventional("feat(api)!: change interface"), true);
  assert.equal(conventional("update stuff"), false);
});
test("UI gate catches text and allows translation keys and locale data", () => {
  assert.ok(uiViolations("apps/miniapp/view.tsx", "<p>Hello</p>").length);
  assert.ok(
    uiViolations("apps/miniapp/view.tsx", '<input placeholder="Name" />')
      .length,
  );
  assert.ok(
    uiViolations("apps/miniapp/view.tsx", 'const label = "Hello";').length,
  );
  assert.deepEqual(
    uiViolations("apps/miniapp/view.tsx", '<p>{t("profile.name")}</p>'),
    [],
  );
  assert.deepEqual(uiViolations("packages/i18n/locales/uk.json", "{}"), []);
});
