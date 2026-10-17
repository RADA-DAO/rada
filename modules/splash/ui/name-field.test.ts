import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "../../../packages/ui/scripts/fake-dom.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import { nameField } from "./name-field.ts";
import type { SplashContext } from "./context.ts";

await test("empty, malformed and unavailable names have distinct translated errors", async () => {
  for (const locale of ["en", "uk"] as const) {
    const context = {
      text: (key: Parameters<typeof t>[1]) => t(locale, key),
      signal: new AbortController().signal,
      client: { nameStatus: () => Promise.resolve("taken") },
    } as unknown as SplashContext;
    const field = nameField(context);
    assert.equal(field.error(), "splash.nameRequired");
    for (const value of ["1frog", "\u0416\u0430\u0431\u0430"]) {
      field.control.value = value;
      fake(field.control).dispatch("input");
      assert.equal(field.error(), "splash.error.invalid_name");
    }
    field.control.value = "Taken";
    fake(field.control).dispatch("input");
    await new Promise((resolve) => setTimeout(resolve, 380));
    assert.equal(field.error(), "splash.error.name_taken");
    field.setError(context.text(field.error() ?? "splash.nameRequired"));
    assert.equal(field.control.getAttribute("aria-invalid"), "true");
    assert.notEqual(
      context.text("splash.error.invalid_name"),
      context.text("splash.error.name_taken"),
    );
    field.dispose();
  }
});
