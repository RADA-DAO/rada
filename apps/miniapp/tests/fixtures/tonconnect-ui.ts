type ConnectedWallet = {
  account: {
    address: string;
    chain: string;
    walletStateInit: string;
    publicKey: string;
  };
  connectItems?: { tonProof: { proof: { payload: string } } };
};

export class TonConnectUI {
  connected = false;
  connectionRestored: Promise<void>;
  private callback: ((wallet: ConnectedWallet | null) => void) | undefined;
  private requestedProof: string | undefined;

  constructor() {
    this.connectionRestored = new Promise((resolve) => {
      setTimeout(() => {
        this.connected =
          localStorage.getItem("fixture-ton-session") === "restored";
        resolve();
      }, 30);
    });
  }

  get account() {
    if (!this.connected) return null;
    return {
      address:
        localStorage.getItem("fixture-ton-account") ?? "restored-session",
      chain: localStorage.getItem("fixture-ton-chain") ?? "-239",
      walletStateInit: "",
      publicKey: "",
    };
  }
  sendTransaction(transaction: unknown) {
    if (localStorage.getItem("fixture-ton-payment") !== "enabled")
      throw new Error("Payment fixture must be explicitly enabled");
    localStorage.setItem(
      "fixture-ton-sends",
      String(Number(localStorage.getItem("fixture-ton-sends") ?? 0) + 1),
    );
    localStorage.setItem(
      "fixture-ton-transaction",
      JSON.stringify(transaction),
    );
    return Promise.resolve({ boc: "synthetic-no-chain-transaction" });
  }
  closeModal() {
    document.dispatchEvent(new Event("fixture-ton-modal-closed"));
  }
  setConnectionNetwork() {}
  setConnectRequestParameters(
    parameters: {
      value?: { tonProof: string };
    } | null,
  ) {
    this.requestedProof = parameters?.value?.tonProof;
  }
  onStatusChange(callback: (wallet: ConnectedWallet | null) => void) {
    this.callback = callback;
    if (this.connected)
      callback({
        account: {
          address: "restored-session",
          chain: "-239",
          walletStateInit: "",
          publicKey: "",
        },
      });
    return () => {
      this.callback = undefined;
    };
  }
  disconnect(): Promise<void> {
    this.connected = false;
    localStorage.removeItem("fixture-ton-session");
    localStorage.setItem(
      "fixture-ton-disconnects",
      String(Number(localStorage.getItem("fixture-ton-disconnects") ?? 0) + 1),
    );
    this.callback?.(null);
    return Promise.resolve();
  }
  async openModal() {
    await this.connectionRestored;
    if (this.connected)
      throw new Error("Restored session was not disconnected");
    const response = await fetch("/__fixture/ton-connect-proof");
    if (!response.ok) throw new Error("Missing fixture proof");
    const proof = (await response.json()) as {
      address: string;
      network: string;
      walletStateInit: string;
      publicKey: string;
      proof: { payload: string };
    };
    if (!this.requestedProof || proof.proof.payload !== this.requestedProof)
      throw new Error("Fresh proof was not requested");
    this.connected = true;
    localStorage.setItem("fixture-ton-session", "restored");
    this.callback?.({
      account: {
        address: proof.address,
        chain: proof.network,
        walletStateInit: proof.walletStateInit,
        publicKey: proof.publicKey,
      },
      connectItems: { tonProof: { proof: proof.proof } },
    });
  }
}
