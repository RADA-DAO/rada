import { Address, beginCell, JettonMaster, TonClient } from "@ton/ton";
import { indexedCoverage } from "./payment-coverage.ts";
import { estimatePaymentFee } from "./payment-fee.ts";
import { JPEGPE_JETTON_MASTER } from "./balances.ts";

export type PaymentRecord = {
  intentId: string;
  token: "TON" | "JPEGPE";
  amount: string;
  recipient: string;
  sender: string;
  purpose: string;
  createdAt: string;
};
/** A finalized on-chain payment: receipt hash and the recipient transaction time (unix seconds). */
export type PaymentConfirmation = { hash: string; onChainAt: number };
export type PaymentScan =
  | ({ status: "confirmed" } & PaymentConfirmation)
  | { status: "confirmed-absent" | "incomplete" };
export type ScanOptions = {
  pageBudget?: number;
  /** Seconds beyond the scan window required for negative evidence (default 600). */
  safetyMarginSeconds?: number;
  /** Trusted index coverage watermark; unavailable coverage always defers absence. */
  indexedThrough?: () => Promise<number | null>;
};
export type SignRequest = {
  network: "-239";
  from: string;
  validUntil: number;
  messages: { address: string; amount: string; payload: string }[];
};
type Dict = Record<string, unknown>;
const object = (value: unknown): Dict | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : null;
const same = (a: unknown, b: string) => {
  try {
    if (typeof a === "string") return Address.parse(a).equals(Address.parse(b));
    const value = object(a);
    return (
      value?.["@type"] === "addr_std" &&
      Address.parse(`${value.workchain_id}:${value.address}`).equals(
        Address.parse(b),
      )
    );
  } catch {
    return false;
  }
};
function receiptHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return null;
  const bytes = Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
  return bytes.length === 32 ? bytes.toString("hex") : null;
}
const confirmed = (hash: unknown, now: unknown): PaymentConfirmation | null => {
  const value = receiptHash(hash);
  return value ? { hash: value, onChainAt: Number(now) } : null;
};
const comment = (intent: PaymentRecord) =>
  `RADA:${intent.intentId}:${intent.purpose}`;
const after = (value: unknown, start: number) =>
  (typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value))) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= start;
const payload = (text: string) =>
  beginCell()
    .storeUint(0, 32)
    .storeStringTail(text)
    .endCell()
    .toBoc()
    .toString("base64");

export class PaymentChain {
  private send: typeof fetch;
  private scanOptions: ScanOptions;
  private resolveJettonWallet: ((owner: string) => Promise<string>) | undefined;
  private ton = new TonClient({
    endpoint: "https://toncenter.com/api/v2/jsonRPC",
    timeout: 5000,
  });
  constructor(
    send: typeof fetch = fetch,
    resolveJettonWallet?: (owner: string) => Promise<string>,
    scanOptions: ScanOptions = {},
  ) {
    this.send = send;
    this.scanOptions = scanOptions;
    this.resolveJettonWallet = resolveJettonWallet;
  }
  private async json(path: string): Promise<Dict> {
    const response = await this.send(`https://toncenter.com/api/v3/${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
      redirect: "error",
    });
    if (
      !response.ok ||
      Number(response.headers.get("content-length")) > 2_000_000
    )
      throw new Error("chain_unavailable");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("chain_unavailable");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          throw new Error("chain_unavailable");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const result = object(value);
    if (!result) throw new Error("chain_unavailable");
    return result;
  }
  private async jettonWallet(owner: string) {
    if (this.resolveJettonWallet) return this.resolveJettonWallet(owner);
    const master = this.ton.open(
      JettonMaster.create(Address.parse(JPEGPE_JETTON_MASTER)),
    );
    return (await master.getWalletAddress(Address.parse(owner))).toRawString();
  }
  /** `notAfter` (unix seconds) caps the signed message lifetime, e.g. a claim deadline. */
  async signRequest(
    intent: PaymentRecord,
    notAfter?: number,
  ): Promise<SignRequest> {
    const validUntil = Math.min(
      Math.floor(Date.now() / 1000) + 180,
      notAfter ?? Number.MAX_SAFE_INTEGER,
    );
    const from = Address.parse(intent.sender).toRawString();
    const address = Address.parse(intent.recipient).toString({
      bounceable: false,
      urlSafe: true,
    });
    if (intent.token === "TON")
      return {
        network: "-239",
        from,
        validUntil,
        messages: [
          { address, amount: intent.amount, payload: payload(comment(intent)) },
        ],
      };
    const jettonWallet = await this.jettonWallet(from);
    const body = beginCell()
      .storeUint(0x0f8a7ea5, 32)
      .storeUint(
        BigInt(`0x${intent.intentId.replaceAll("-", "")}`) & ((1n << 64n) - 1n),
        64,
      )
      .storeCoins(BigInt(intent.amount))
      .storeAddress(Address.parse(intent.recipient))
      .storeAddress(Address.parse(from))
      .storeMaybeRef(null)
      .storeCoins(50_000_000n)
      .storeBit(true)
      .storeRef(
        beginCell().storeUint(0, 32).storeStringTail(comment(intent)).endCell(),
      )
      .endCell()
      .toBoc()
      .toString("base64");
    return {
      network: "-239",
      from,
      validUntil,
      messages: [
        {
          address: Address.parse(jettonWallet).toString({
            bounceable: true,
            urlSafe: true,
          }),
          amount: "100000000",
          payload: body,
        },
      ],
    };
  }
  async estimateFee(intent: PaymentRecord) {
    return await estimatePaymentFee(this.ton, await this.signRequest(intent));
  }
  async receipt(intent: PaymentRecord): Promise<string | null> {
    const result = await this.confirmation(intent);
    return result.status === "confirmed" ? result.hash : null;
  }
  async confirmation(
    intent: PaymentRecord,
    until?: number,
  ): Promise<PaymentScan> {
    try {
      return await this.scan(intent, until ?? Math.floor(Date.now() / 1000));
    } catch {
      return { status: "incomplete" };
    }
  }
  private async scan(intent: PaymentRecord, end: number): Promise<PaymentScan> {
    const start = Math.floor(new Date(intent.createdAt).getTime() / 1000);
    if (
      !Number.isSafeInteger(start) ||
      start <= 0 ||
      !Number.isSafeInteger(end) ||
      end < start
    )
      return { status: "incomplete" };
    const ton = intent.token === "TON";
    const query = new URLSearchParams({
      ...(ton
        ? { account: intent.recipient }
        : {
            owner_address: intent.recipient,
            direction: "in",
            jetton_master: JPEGPE_JETTON_MASTER,
          }),
      start_utime: String(start),
      end_utime: String(end),
      sort: "asc",
      limit: "100",
    });
    // Coverage failures must never hide a positive receipt.
    const indexed = await (
      this.scanOptions.indexedThrough
        ? this.scanOptions.indexedThrough()
        : indexedCoverage((path) => this.json(path))
    ).catch(() => null);
    const margin = this.scanOptions.safetyMarginSeconds ?? 600;
    let ambiguous = false;
    const budget = Math.min(this.scanOptions.pageBudget ?? 10, 100);
    for (let page = 0; page < budget; page++) {
      query.set("offset", String(page * 100));
      const response = await this.json(
        `${ton ? "transactions" : "jetton/transfers"}?${query}`,
      );
      const rows = response[ton ? "transactions" : "jetton_transfers"];
      if (!Array.isArray(rows)) return { status: "incomplete" };
      const receipt = ton
        ? this.tonConfirmation(intent, rows, start, end)
        : await this.jettonConfirmation(intent, rows, start, end);
      if (receipt) return { status: "confirmed", ...receipt };
      // Unfinalized candidates may still become receipts after this read.
      ambiguous ||= rows.some((value) => {
        const row = object(value);
        return ton
          ? row?.finality !== "finalized"
          : object(row?.decoded_forward_payload)?.comment === comment(intent);
      });
      if (rows.length < 100) {
        return {
          status:
            !ambiguous &&
            indexed != null &&
            Number.isSafeInteger(indexed) &&
            Number.isSafeInteger(margin) &&
            margin >= 0 &&
            indexed >= end + margin &&
            indexed <= Math.floor(Date.now() / 1000) &&
            end <= Math.floor(Date.now() / 1000)
              ? "confirmed-absent"
              : "incomplete",
        };
      }
    }
    return { status: "incomplete" };
  }
  private tonConfirmation(
    intent: PaymentRecord,
    transactions: unknown[],
    start: number,
    end: number,
  ) {
    for (const candidate of transactions) {
      const tx = object(candidate),
        inbound = object(tx?.in_msg);
      const content = object(inbound?.message_content);
      const decoded = object(content?.decoded);
      if (
        tx?.finality !== "finalized" ||
        tx?.emulated !== false ||
        !after(tx.mc_block_seqno, 1) ||
        object(tx.description)?.aborted !== false ||
        inbound?.bounced !== false ||
        !same(tx.account, intent.recipient) ||
        !same(inbound?.source, intent.sender) ||
        !same(inbound?.destination, intent.recipient) ||
        inbound?.value !== intent.amount ||
        !after(tx.now, start) ||
        Number(tx.now) > end ||
        (decoded?.comment !== comment(intent) &&
          decoded?.text !== comment(intent)) ||
        !receiptHash(tx.hash)
      )
        continue;
      return confirmed(tx.hash, tx.now);
    }
    return null;
  }
  private async jettonConfirmation(
    intent: PaymentRecord,
    transfers: unknown[],
    start: number,
    end: number,
  ) {
    for (const candidate of transfers) {
      const row = object(candidate),
        decoded = object(row?.decoded_forward_payload);
      if (
        !same(row?.source, intent.sender) ||
        !same(row?.destination, intent.recipient) ||
        !same(row?.jetton_master, JPEGPE_JETTON_MASTER) ||
        row?.amount !== intent.amount ||
        row?.transaction_aborted !== false ||
        !after(row?.transaction_now, start) ||
        Number(row?.transaction_now) > end ||
        decoded?.comment !== comment(intent) ||
        typeof row?.trace_id !== "string"
      )
        continue;
      const sourceWallet = await this.jettonWallet(intent.sender);
      const recipientWallet = await this.jettonWallet(intent.recipient);
      if (!same(row.source_wallet, sourceWallet)) continue;
      const traces = (
        await this.json(
          `traces?${new URLSearchParams({ trace_id: row.trace_id })}`,
        )
      ).traces;
      const trace = Array.isArray(traces) ? object(traces[0]) : null;
      if (
        trace?.is_incomplete !== false ||
        object(trace.trace_info)?.trace_state !== "complete" ||
        !after(trace.mc_seqno_end, 1)
      )
        continue;
      const transactions = object(trace.transactions);
      if (!transactions) continue;
      for (const value of Object.values(transactions)) {
        const tx = object(value),
          inbound = object(tx?.in_msg);
        const body = object(object(inbound?.message_content)?.decoded);
        const amount = object(body?.amount);
        const forward = object(object(body?.forward_payload)?.value);
        if (
          tx?.finality !== "finalized" ||
          tx?.emulated !== false ||
          object(tx?.description)?.aborted !== false ||
          !same(tx?.account, intent.recipient) ||
          !same(inbound?.source, recipientWallet) ||
          !same(inbound?.destination, intent.recipient) ||
          !after(tx.mc_block_seqno, 1) ||
          inbound?.opcode !== "0x7362d09c" ||
          inbound?.bounced !== false ||
          amount?.value !== intent.amount ||
          !same(body?.sender, intent.sender) ||
          forward?.text !== comment(intent) ||
          !after(tx.now, start) ||
          Number(tx.now) > end ||
          !receiptHash(tx.hash)
        )
          continue;
        return confirmed(tx.hash, tx.now);
      }
    }
    return null;
  }
}
