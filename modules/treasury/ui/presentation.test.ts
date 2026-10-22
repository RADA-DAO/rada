import assert from "node:assert/strict";
import { test } from "node:test";
import { fake, fakeDocument } from "../../../packages/ui/scripts/fake-dom.ts";
import { presentation, type Wallet } from "./presentation.ts";

Object.assign(fakeDocument, {
  createElementNS: (_namespace: string, tag: string) =>
    fakeDocument.createElement(tag),
});
const wallet: Wallet = {
  address: "fixture",
  balances: { TON: "1000000000", JPEGPE: "1300000123456789" },
  asOf: "2026-10-01T00:00:00Z",
  stale: false,
  historyStale: false,
  indexedThrough: null,
  signers: [null],
  signersAsOf: null,
  signersStale: false,
};

await test("collapsed wallet details contain no hidden signer names", () => {
  const row = fake(presentation("en").wallet(wallet, 0));
  const button = row.all("rada-treasury-wallet")[0];
  const details = row.all("rada-treasury-details")[0];
  assert.ok(button);
  assert.ok(details);
  assert.equal(details.textContent, "");
  button.click();
  assert.match(details.textContent, /Anonymous/);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  button.click();
  assert.equal(details.textContent, "");
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

for (const locale of ["en", "uk"] as const) {
  for (const failure of ["constructor", "format"] as const) {
    await test(`treasury survives Intl ${failure} failure (${locale})`, (context) => {
      const broken = class {
        constructor() {
          if (failure === "constructor") throw new RangeError("unsupported");
        }
        format() {
          throw new RangeError("unsupported");
        }
      };
      context.mock.method(Intl, "NumberFormat", broken);
      context.mock.method(Intl, "DateTimeFormat", broken);
      const view = presentation(locale);
      assert.equal(view.summary([]), null);
      const row = fake(view.wallet(wallet, 0));
      const exact = `1300000${locale === "uk" ? "," : "."}123456789 JPEGPE`;
      assert.match(row.textContent, new RegExp(exact.replace(".", "\\.")));
      const button = row.all("rada-treasury-wallet")[0];
      assert.ok(button);
      button.click();
      assert.match(row.textContent, /2026-10-01/);
      const history = fake(
        view.history(
          [
            {
              id: "1",
              at: "2026-10-01T00:00:00Z",
              direction: "out",
              token: "JPEGPE",
              amount: "1300000123456789",
              person: null,
              decisions: [],
            },
          ],
          () => {},
        )[0],
      );
      assert.ok(history.textContent.includes(`−${exact}`));
      assert.ok(
        history.all("rada-treasury-movement")[0]?.title.includes(exact),
      );
    });
  }
}
