import type { TonConnectUI } from "@tonconnect/ui";
import { Button } from "../../../packages/ui/src/index.ts";
import { t, type Locale } from "../../../packages/i18n/src/index.ts";
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
): () => void {
  const controller = new AbortController();
  const text = (key: Parameters<typeof t>[1]) => t(locale, key);
  let disposed = false;
  const isDisposed = () => disposed;
  let busy = false;
  let challenge: string | null = null;
  let connector: TonConnectUI | undefined;
  let unsubscribe: (() => void) | undefined;
  const heading = document.createElement("h2");
  heading.textContent = text("wallet.title");
  const status = document.createElement("p");
  status.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  const connectButton = Button(text("wallet.connect"), {
    onClick: () => void connect(),
  });
  container.append(heading, connectButton, status, list);
  async function refresh() {
    status.textContent = text("wallet.loading");
    try {
      const [wallets, balances] = await Promise.all([
        platform.readOwnWallets(controller.signal),
        platform.readOwnWalletBalances(controller.signal),
      ]);
      if (isDisposed()) return;
      list.replaceChildren();
      status.textContent = wallets.length ? "" : text("wallet.empty");
      for (const wallet of wallets) {
        const row = document.createElement("section");
        const address = document.createElement("p");
        address.textContent = wallet.address;
        const value = balances.find(
          (item) => item.address === wallet.address,
        )?.balances;
        const balance = document.createElement("p");
        balance.textContent = `${text("wallet.ton")}: ${value?.gram?.formatted ?? text("wallet.balanceUnknown")} · ${text("wallet.jpegpe")}: ${value?.jpegpe?.formatted ?? text("wallet.balanceUnknown")}`;
        row.append(
          address,
          balance,
          Button(text("wallet.revoke"), {
            onClick: () => void revoke(wallet.address),
          }),
        );
        list.append(row);
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
    status.textContent = text("wallet.linking");
    try {
      if (location.protocol !== "https:" && location.hostname !== "localhost")
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
