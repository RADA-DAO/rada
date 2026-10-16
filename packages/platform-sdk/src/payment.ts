import type { SheetNavigation } from "../../ui/src/index.ts";
import {
  windowConfirm,
  type Payment,
  type PaymentCopy,
} from "./payment-window.ts";
export type { PaymentCopy } from "./payment-window.ts";
import type { TonConnectUI } from "@tonconnect/ui";

export type PaymentRequest = {
  idempotencyKey: string;
  token: "TON" | "JPEGPE";
  amount: string;
  recipient: string;
  purpose: string;
};
export type PaymentResult = {
  intentId: string;
  status: "prepared" | "unknown" | "paid" | "cancelled";
};
type SignRequest = {
  network: "-239";
  from: string;
  validUntil: number;
  messages: { address: string; amount: string; payload: string }[];
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("unavailable");
  return value as Record<string, unknown>;
};
function mainnetAddress(value: string): boolean {
  if (/^0:[0-9a-f]{64}$/i.test(value)) return true;
  if (!/^[A-Za-z0-9_-]{48}$/.test(value)) return false;
  try {
    const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    return (
      (bytes.charCodeAt(0) === 0x11 || bytes.charCodeAt(0) === 0x51) &&
      bytes.charCodeAt(1) === 0
    );
  } catch {
    return false;
  }
}
function readPayment(value: unknown): Payment {
  const p = object(value);
  if (
    typeof p.intentId !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(p.intentId) ||
    !["prepared", "unknown", "paid", "cancelled"].includes(String(p.status)) ||
    !["TON", "JPEGPE"].includes(String(p.token)) ||
    typeof p.amount !== "string" ||
    typeof p.recipient !== "string" ||
    typeof p.sender !== "string" ||
    typeof p.purpose !== "string" ||
    p.network !== "-239" ||
    !(p.gasBudget === null || typeof p.gasBudget === "string")
  )
    throw new Error("unavailable");
  if (p.feeEstimate !== null) {
    const fee = object(p.feeEstimate);
    if (
      typeof fee.nano !== "string" ||
      !/^[1-9][0-9]{0,30}$/.test(fee.nano) ||
      typeof fee.expiresAt !== "number" ||
      !Number.isSafeInteger(fee.expiresAt)
    )
      throw new Error("unavailable");
  }
  return p as Payment;
}

async function cancellable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => {
          reject(new Error("timeout"));
        };
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function paymentAdapter(
  base: string,
  authHeaders: () => { Authorization: string } | null,
  navigation?: SheetNavigation,
) {
  const endpoint = `${base}/payments`;
  let walletPromise: Promise<TonConnectUI> | undefined;
  const connector = () =>
    (walletPromise ??= import("@tonconnect/ui").then(({ TonConnectUI }) => {
      const wallet = new TonConnectUI({
        manifestUrl: new URL("/tonconnect-manifest.json", location.origin).href,
      });
      wallet.setConnectionNetwork("-239");
      return wallet;
    }));
  async function call(
    path: string,
    method: "GET" | "POST",
    input?: object,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const headers = authHeaders();
    if (!headers) throw new Error("expired");
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        ...headers,
        ...(input ? { "Content-Type": "application/json" } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
      credentials: "omit",
      cache: "no-store",
      signal: signal ?? null,
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "expired"
          : response.status === 403
            ? "forbidden"
            : response.status === 409
              ? "conflict"
              : "unavailable",
      );
    return object(await response.json());
  }
  async function status(
    appId: string,
    intentId: string,
  ): Promise<PaymentResult> {
    if (!/^[a-f0-9-]{36}$/i.test(intentId)) throw new Error("invalid_request");
    const payment = readPayment(
      (await call(`/${intentId}?appId=${encodeURIComponent(appId)}`, "GET"))
        .payment,
    );
    return { intentId: payment.intentId, status: payment.status };
  }
  return {
    paymentStatus: status,
    async requestPayment(
      appId: string,
      input: unknown,
      copy: PaymentCopy,
      signal: AbortSignal,
    ): Promise<PaymentResult> {
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(",") !==
          "amount,idempotencyKey,purpose,recipient,token"
      )
        throw new Error("invalid_request");
      const request = input as PaymentRequest;
      if (
        !/^[a-z][a-z0-9_.:-]{0,127}$/.test(appId) ||
        typeof request.idempotencyKey !== "string" ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(request.idempotencyKey) ||
        typeof request.token !== "string" ||
        !["TON", "JPEGPE"].includes(request.token) ||
        typeof request.amount !== "string" ||
        !/^[1-9][0-9]{0,76}$/.test(request.amount) ||
        BigInt(request.amount) > (1n << 120n) - 1n ||
        typeof request.recipient !== "string" ||
        !mainnetAddress(request.recipient) ||
        typeof request.purpose !== "string" ||
        request.purpose.trim() !== request.purpose ||
        !/^[\p{L}\p{N} .,!?_-]{1,80}$/u.test(request.purpose)
      )
        throw new Error("invalid_request");
      signal.throwIfAborted();
      const wallet = await connector();
      await cancellable(wallet.connectionRestored, signal);
      signal.throwIfAborted();
      if (
        !wallet.connected ||
        !wallet.account ||
        wallet.account.chain !== "-239"
      )
        throw new Error("wallet_unavailable");
      const sender = wallet.account.address;
      const payment = readPayment(
        (await call("", "POST", { ...request, appId, sender }, signal)).payment,
      );
      return await confirmAndSign(appId, payment, copy, signal);
    },
    /**
     * The address of the wallet connected through TON Connect, or null when no
     * mainnet wallet is connected. Linking itself stays in the wallet screen.
     */
    async connectedWallet(signal: AbortSignal): Promise<string | null> {
      const wallet = await connector();
      await cancellable(wallet.connectionRestored, signal);
      return wallet.connected && wallet.account?.chain === "-239"
        ? wallet.account.address
        : null;
    },
    /**
     * Opens the payment window for an intent a platform module already
     * prepared on the server (for example a SPLASH claim). The terms come from
     * the server; the person still confirms them here.
     */
    async payIntent(
      appId: string,
      intent: unknown,
      copy: PaymentCopy,
      signal: AbortSignal,
    ): Promise<PaymentResult> {
      if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(appId))
        throw new Error("invalid_request");
      return await confirmAndSign(appId, readPayment(intent), copy, signal);
    },
  };
  async function confirmAndSign(
    appId: string,
    payment: Payment,
    copy: PaymentCopy,
    signal: AbortSignal,
  ): Promise<PaymentResult> {
    if (payment.status !== "prepared")
      return { intentId: payment.intentId, status: payment.status };
    const wallet = await connector();
    await cancellable(wallet.connectionRestored, signal);
    signal.throwIfAborted();
    // The connected wallet must be the intent's sender (raw form ignores case).
    const sender = wallet.account?.address ?? "";
    if (
      !wallet.connected ||
      wallet.account?.chain !== "-239" ||
      sender.toLowerCase() !== payment.sender.toLowerCase()
    )
      throw new Error("wallet_unavailable");
    if (
      !payment.feeEstimate ||
      payment.feeEstimate.expiresAt <= Date.now() / 1000
    )
      throw new Error("fee_unavailable");
    if (!(await windowConfirm(payment, copy, signal, navigation))) {
      signal.throwIfAborted();
      const cancelled = readPayment(
        (
          await call(
            `/${payment.intentId}/cancel?appId=${encodeURIComponent(appId)}`,
            "POST",
            undefined,
            signal,
          )
        ).payment,
      );
      return { intentId: cancelled.intentId, status: cancelled.status };
    }
    signal.throwIfAborted();
    if (payment.feeEstimate.expiresAt <= Date.now() / 1000)
      throw new Error("fee_expired");
    const currentAccount: unknown = wallet.account;
    const current = object(currentAccount);
    if (current.chain !== "-239" || current.address !== sender)
      throw new Error("wallet_changed");
    const claimed = await call(
      `/${payment.intentId}/claim?appId=${encodeURIComponent(appId)}`,
      "POST",
      undefined,
      signal,
    );
    signal.throwIfAborted();
    if (claimed.signRequest === null)
      return {
        intentId: payment.intentId,
        status: readPayment(claimed.payment).status,
      };
    const tx = object(claimed.signRequest);
    if (
      tx.network !== "-239" ||
      String(tx.from).toLowerCase() !== payment.sender.toLowerCase() ||
      !Array.isArray(tx.messages) ||
      tx.messages.length !== 1
    )
      throw new Error("unavailable");
    const latest: unknown = wallet.account;
    const latestAccount = object(latest);
    if (latestAccount.chain !== "-239" || latestAccount.address !== sender)
      throw new Error("wallet_changed");
    signal.throwIfAborted();
    const abortWallet = () => {
      try {
        wallet.closeModal();
      } catch {
        /* Reconciliation remains available. */
      }
    };
    signal.addEventListener("abort", abortWallet, { once: true });
    try {
      await cancellable(wallet.sendTransaction(tx as SignRequest), signal);
    } catch {
      /* The wallet may have sent it; reconciliation is the only safe next step. */
    } finally {
      signal.removeEventListener("abort", abortWallet);
    }
    signal.throwIfAborted();
    return status(appId, payment.intentId);
  }
}
