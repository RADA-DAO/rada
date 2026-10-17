import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "../../../packages/ui/scripts/fake-dom.ts";
import { Group } from "../../../packages/ui/src/index.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import { mountWallet } from "../src/wallet.ts";

await test("wallet disclosures and repeated actions work without hover in both locales", async () => {
  const addresses = [`0:${"1".repeat(64)}`, `0:${"2".repeat(64)}`];
  for (const locale of ["en", "uk"] as const) {
    const container = Group();
    const dispose = mountWallet(container, locale, {
      readOwnWallets: () =>
        Promise.resolve(
          addresses.map((address) => ({
            address,
            network: "-239" as const,
            verifiedAt: "2026-10-17T00:00:00Z",
          })),
        ),
      readOwnWalletBalances: () => Promise.resolve([]),
      issueWalletChallenge: () => Promise.resolve("fixture"),
      linkWallet: () => Promise.resolve(),
      revokeWallet: () => Promise.resolve(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rows = fake(container).all("rada-list-item");
    assert.equal(rows.length, 2);
    rows.forEach((row, index) => {
      const address = addresses[index] ?? "";
      const [details, copy, revoke] = row.all("rada-button");
      assert.ok(details && copy && revoke);
      assert.equal(
        copy.getAttribute("aria-label"),
        t(locale, "wallet.copyAddressFor", { address }),
      );
      assert.equal(
        revoke.getAttribute("aria-label"),
        t(locale, "wallet.revokeFor", { address }),
      );
      const full = row
        .all("rada-text")
        .find((item) => item.textContent === address);
      assert.ok(full?.hidden);
      details.click();
      assert.equal(full.hidden, false);
      assert.equal(details.getAttribute("aria-expanded"), "true");
      details.click();
      assert.equal(full.hidden, true);
    });
    dispose();
  }
});
