import { profileActionIcon } from "../../../packages/ui/src/frog-card.ts";
import type { TonConnectUI } from "@tonconnect/ui";
import {
  Button,
  Group,
  Avatar,
  List,
  ListItem,
  Section,
  setButtonLoading,
  Text,
} from "../../../packages/ui/src/index.ts";
import {
  displayAmount,
  t,
  type Locale,
} from "../../../packages/i18n/src/index.ts";
import type {
  LinkedWallet,
  WalletBalances,
  WalletProof,
} from "../../../packages/platform-sdk/src/index.ts";

type WalletPlatform = {
  readOwnWallets(signal?: AbortSignal): Promise<LinkedWallet[]>;
  readOwnWalletBalances(signal?: AbortSignal): Promise<WalletBalances[]>;
  issueWalletChallenge(signal?: AbortSignal): Promise<string>;
  linkWallet(input: WalletProof, signal?: AbortSignal): Promise<void>;
  revokeWallet(address: string, signal?: AbortSignal): Promise<void>;
};

export function mountWallet(
  container: HTMLElement,
  locale: Locale,
  platform: WalletPlatform,
  actions?: HTMLElement,
): () => void {
  const controller = new AbortController();
  const text = (key: Parameters<typeof t>[1]) => t(locale, key);
  let disposed = false;
  const isDisposed = () => disposed;
  let busy = false;
  let challenge: string | null = null;
  let connector: TonConnectUI | undefined;
  let unsubscribe: (() => void) | undefined;
  const status = Text("", { live: "polite" });
  status.classList.add("rada-profile-wallet-status");
  const list = List({ label: text("wallet.title") });
  const connectButton = Button(text("wallet.connect"), {
    variant: "primary",
    onClick: () => void connect(),
  });
  const manager = Section({
    title: text("wallet.title"),
    children: [connectButton, list],
  });
  manager.classList.add("rada-profile-wallet-manager");
  manager.hidden = Boolean(actions);
  manager.id = "profile-wallet-manager";
  if (actions) {
    const manage = profileActionIcon(
      Button(text("wallet.title"), {
        onClick: () => {
          manager.hidden = !manager.hidden;
          manage.setAttribute("aria-expanded", String(!manager.hidden));
        },
      }),
      "wallet",
    );
    manage.setAttribute("aria-expanded", "false");
    manage.setAttribute("aria-controls", manager.id);
    actions.prepend(manage);
  }
  const assets = List({ label: text("wallet.title") });
  assets.classList.add("rada-profile-assets");
  container.append(assets, status, manager);
  async function refresh() {
    status.textContent = text("wallet.loading");
    try {
      const [wallets, balances] = await Promise.all([
        platform.readOwnWallets(controller.signal),
        platform.readOwnWalletBalances(controller.signal),
      ]);
      if (isDisposed()) return;
      list.replaceChildren();
      assets.replaceChildren();
      status.textContent = wallets.length ? "" : text("wallet.empty");
      if (wallets.length) {
        for (const token of ["jpegpe", "gram"] as const) {
          const amounts = wallets.map(
            (wallet) =>
              balances.find((item) => item.address === wallet.address)
                ?.balances[token],
          );
          const amount = amounts.every(
            (value) => value !== null && value !== undefined,
          )
            ? {
                raw: amounts
                  .reduce((sum, value) => sum + BigInt(value.raw), 0n)
                  .toString(),
                decimals: 9,
              }
            : null;
          const label = text(token === "gram" ? "wallet.ton" : "wallet.jpegpe");
          const position = walletPosition(
            displayAmount(amount, locale, 0, amount?.decimals ?? 9) ??
              text("wallet.dash"),
          );
          const row = ListItem({
            leading: Avatar({
              name: label,
              imageUrl:
                token === "jpegpe"
                  ? "/profile/jpegpe.webp"
                  : "/profile/ton.svg",
            }),
            title: label,
          });
          row.append(position);
          assets.append(row);
        }
      }
      for (const wallet of wallets) {
        const value = balances.find(
          (item) => item.address === wallet.address,
        )?.balances;
        const tonDigits =
          value?.gram && BigInt(value.gram.raw) >= 1000n * 10n ** 9n ? 2 : 4;
        const ton = displayAmount(value?.gram ?? null, locale, 2, tonDigits);
        const jpegpe = displayAmount(value?.jpegpe ?? null, locale, 2);
        const short = `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`;
        const address = Text(wallet.address);
        address.hidden = true;
        address.id = `wallet-address-${wallet.address}`;
        const details = Button(
          t(locale, "wallet.showAddress", { address: short }),
          {
            onClick: () => {
              address.hidden = !address.hidden;
              details.setAttribute("aria-expanded", String(!address.hidden));
              details.textContent = t(
                locale,
                address.hidden ? "wallet.showAddress" : "wallet.hideAddress",
                { address: short },
              );
            },
          },
        );
        details.setAttribute("aria-expanded", "false");
        details.setAttribute("aria-controls", address.id);
        list.append(
          ListItem({
            title: `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}`,
            children: [address],
            description: `${text("wallet.ton")}: ${ton ?? text("wallet.balanceUnknown")} · ${text("wallet.jpegpe")}: ${jpegpe ?? text("wallet.balanceUnknown")}`,
            actions: [
              details,
              Button(text("wallet.copyAddress"), {
                ariaLabel: t(locale, "wallet.copyAddressFor", {
                  address: wallet.address,
                }),
                onClick: () => void copyAddress(wallet.address),
              }),
              Button(text("wallet.revoke"), {
                ariaLabel: t(locale, "wallet.revokeFor", {
                  address: wallet.address,
                }),
                onClick: () => void revoke(wallet.address),
              }),
            ],
          }),
        );
      }
    } catch {
      if (!isDisposed()) status.textContent = text("wallet.unavailable");
    }
  }
  async function revoke(address: string) {
    if (busy || isDisposed()) return;
    busy = true;
    try {
      await platform.revokeWallet(address, controller.signal);
      const restored = await ensureConnector();
      if (restored?.connected) await restored.disconnect().catch(() => {});
      if (!isDisposed()) await refresh();
    } catch {
      if (!isDisposed()) status.textContent = text("wallet.unavailable");
    } finally {
      busy = false;
    }
  }
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      if (!isDisposed()) status.textContent = text("wallet.addressCopied");
    } catch {
      if (!isDisposed()) status.textContent = text("wallet.copyUnavailable");
    }
  }
  // TON Connect restores a remembered session asynchronously. Waiting for it keeps a
  // restored, proof-less session from racing a fresh proof request.
  async function ensureConnector(): Promise<TonConnectUI | undefined> {
    if (!connector) {
      const { TonConnectUI } = await import("@tonconnect/ui");
      if (isDisposed()) return undefined;
      connector = new TonConnectUI({
        manifestUrl: new URL("/tonconnect-manifest.json", location.origin).href,
      });
      connector.setConnectionNetwork("-239");
    }
    await connector.connectionRestored;
    return connector;
  }
  async function connect() {
    if (busy || isDisposed()) return;
    busy = true;
    setButtonLoading(connectButton, true);
    status.textContent = text("wallet.linking");
    try {
      if (
        location.protocol !== "https:" &&
        !["localhost", "127.0.0.1"].includes(location.hostname)
      )
        throw new Error("unavailable");
      challenge = await platform.issueWalletChallenge(controller.signal);
      if (isDisposed()) return;
      const restored = await ensureConnector();
      if (!restored || isDisposed()) return;
      connector = restored;
      if (connector.connected) await connector.disconnect();
      connector.setConnectRequestParameters({
        state: "ready",
        value: { tonProof: challenge },
      });
      unsubscribe ??= connector.onStatusChange(
        (wallet) => {
          if (!wallet || !challenge || isDisposed()) return;
          const item = wallet.connectItems?.tonProof;
          if (!item || !("proof" in item) || item.proof.payload !== challenge) {
            status.textContent = text("wallet.unsupported");
            return;
          }
          challenge = null;
          void platform
            .linkWallet(
              {
                address: wallet.account.address,
                network: wallet.account.chain,
                walletStateInit: wallet.account.walletStateInit,
                ...(wallet.account.publicKey === undefined
                  ? {}
                  : { publicKey: wallet.account.publicKey }),
                proof: item.proof,
              },
              controller.signal,
            )
            .then(() => {
              if (!isDisposed()) void refresh();
            })
            .catch(() => {
              if (!isDisposed())
                status.textContent = text("wallet.unavailable");
            });
        },
        () => {
          if (!isDisposed()) status.textContent = text("wallet.unavailable");
        },
      );
      await connector.openModal();
    } catch {
      if (!isDisposed()) status.textContent = text("wallet.unavailable");
    } finally {
      busy = false;
      setButtonLoading(connectButton, false);
    }
  }
  void refresh();
  return () => {
    disposed = true;
    challenge = null;
    controller.abort();
    unsubscribe?.();
    connector?.setConnectRequestParameters(null);
  };
}

/** USD valuations use the primary line; unvalued tokens show their exact amount. */
export function walletPosition(amount: string, usdValue?: string): HTMLElement {
  const position = Group([
    Text(usdValue ?? amount),
    ...(usdValue ? [Text(amount)] : []),
  ]);
  position.classList.add("rada-profile-position");
  return position;
}
