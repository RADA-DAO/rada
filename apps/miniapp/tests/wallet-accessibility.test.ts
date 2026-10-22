import assert from "node:assert/strict";
import { test } from "node:test";
import { fake, FakeElement } from "../../../packages/ui/scripts/fake-dom.ts";
import { Button, Group } from "../../../packages/ui/src/index.ts";
import { t } from "../../../packages/i18n/src/index.ts";
import { mountWallet, walletPosition } from "../src/wallet.ts";
import { loadFrogArtwork } from "../../../packages/ui/src/frog-artwork.ts";
import { profileActionIcon } from "../../../packages/ui/src/frog-card.ts";

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
    const rows =
      fake(container).all("rada-section")[0]?.all("rada-list-item") ?? [];
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

await test("profile action preserves the accessible name of an icon-only control", () => {
  Object.defineProperty(document, "createElementNS", {
    configurable: true,
    value: (_namespace: string, tag: string) => new FakeElement(tag),
  });
  try {
    const button = Button(t("en", "shell.settings"), { icon: "settings" });
    profileActionIcon(button, "notifications");
    assert.equal(button.getAttribute("aria-label"), t("en", "shell.settings"));
    assert.equal(button.dataset.icon, undefined);
  } finally {
    Reflect.deleteProperty(document, "createElementNS");
  }
});

await test("unvalued profile balances are exact, trimmed and primary in both locales", async () => {
  for (const locale of ["en", "uk"] as const) {
    for (const raw of ["12840000000000000", "12480000000", "500000000", "1"]) {
      const container = Group();
      const address = `0:${"1".repeat(64)}`;
      const dispose = mountWallet(container, locale, {
        readOwnWallets: () =>
          Promise.resolve([
            { address, network: "-239", verifiedAt: "2026-10-17T00:00:00Z" },
          ]),
        readOwnWalletBalances: () =>
          Promise.resolve([
            {
              address,
              balances: {
                jpegpe: { raw, decimals: 9, formatted: "" },
                gram: null,
                balancesUpdatedAt: null,
              },
            },
          ]),
        issueWalletChallenge: () => Promise.resolve("fixture"),
        linkWallet: () => Promise.resolve(),
        revokeWallet: () => Promise.resolve(),
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(fake(container).all("rada-profile-total").length, 0);
      const assets = fake(container).all("rada-profile-assets")[0];
      assert.ok(assets);
      assert.equal(assets.all("rada-list-item-text").length, 0);
      const positions = assets.all("rada-profile-position");
      const expected = new Intl.NumberFormat(locale, {
        maximumFractionDigits: 9,
      }).format(Number(raw) / 1e9);
      assert.equal(positions[0]?.textContent, expected);
      assert.equal(positions[0].children.length, 1);
      assert.equal(positions[1]?.textContent, t(locale, "wallet.dash"));
      dispose();
    }
  }
  const valued = fake(walletPosition("12.48", "$18.73"));
  assert.equal(valued.child(0).textContent, "$18.73");
  assert.equal(valued.child(1).textContent, "12.48");
});

await test("profile missing artwork stays accessible without visible placeholder copy", async () => {
  const target = Group();
  const controller = new AbortController();
  loadFrogArtwork(target, {
    alt: "Frog",
    missingArtLabel: "Artwork unavailable",
    accessiblePlaceholderOnly: true,
    signal: controller.signal,
    load: () => Promise.reject(new Error("offline")),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fake(target).textContent, "");
  assert.equal(fake(target).child(0).getAttribute("role"), "img");
  assert.equal(
    fake(target).child(0).getAttribute("aria-label"),
    "Artwork unavailable",
  );
  controller.abort();
});
