import {
  Address,
  Cell,
  internal,
  SendMode,
  TonClient,
  WalletContractV1R1,
  WalletContractV1R2,
  WalletContractV1R3,
  WalletContractV2R1,
  WalletContractV2R2,
  WalletContractV3R1,
  WalletContractV3R2,
  WalletContractV4,
  WalletContractV5R1,
} from "@ton/ton";
import type { SignRequest } from "./payment-chain.ts";

export type FeeEstimate = { nano: string; expiresAt: number };
type Reader = Pick<
  TonClient,
  "getContractState" | "estimateExternalMessageFee"
>;
const variants = [
  { contract: WalletContractV1R1, version: 1 },
  { contract: WalletContractV1R2, version: 1 },
  { contract: WalletContractV1R3, version: 1 },
  { contract: WalletContractV2R1, version: 2 },
  { contract: WalletContractV2R2, version: 2 },
  { contract: WalletContractV3R1, version: 3 },
  { contract: WalletContractV3R2, version: 3 },
  { contract: WalletContractV4, version: 4 },
].map((variant) => ({
  ...variant,
  code: variant.contract.create({ workchain: 0, publicKey: Buffer.alloc(32) })
    .init.code,
}));

// Read-only emulation of the exact outgoing message. The placeholder signature
// is never broadcast; tonlib ignores it when estimating. Unknown contract code
// fails closed rather than presenting a fabricated fee.
export async function estimatePaymentFee(
  reader: Reader,
  request: SignRequest,
): Promise<FeeEstimate> {
  const sender = Address.parse(request.from);
  const state = await reader.getContractState(sender);
  if (state.state !== "active" || !state.code || !state.data)
    throw new Error("fee_unavailable");
  const code = Cell.fromBoc(state.code)[0];
  const data = Cell.fromBoc(state.data)[0]?.beginParse();
  const variant = variants.find((item) => code?.equals(item.code));
  const v5 = code?.equals(
    WalletContractV5R1.create({ publicKey: Buffer.alloc(32) }).init.code,
  );
  const version = v5 ? 5 : variant?.version;
  if (!version || !data) throw new Error("fee_unavailable");
  if (version === 5 && !data.loadBoolean()) throw new Error("fee_unavailable");
  const seqno = data.loadUint(32);
  const walletId = version >= 3 ? data.loadUint(32) : undefined;
  const publicKey = data.loadBuffer(32);
  const message = request.messages[0];
  if (!message || request.messages.length !== 1)
    throw new Error("fee_unavailable");
  const transfer = internal({
    to: message.address,
    value: BigInt(message.amount),
    bounce: Address.parseFriendly(message.address).isBounceable,
    body: Cell.fromBase64(message.payload),
  });
  const args = {
    seqno,
    secretKey: Buffer.alloc(64),
    sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    timeout: request.validUntil,
    messages: [transfer],
    message: transfer,
  };
  let body: Cell;
  if (version === 5) {
    if (walletId === undefined) throw new Error("fee_unavailable");
    // Wallet v5 serializes global_id XOR context_id. The supported client
    // context is workchain:int8, version:uint8, counter:uint15.
    const contextId = (walletId ^ -239) >>> 0;
    const isClient = contextId >>> 31 === 1;
    if (isClient && ((contextId >>> 15) & 255) !== 0)
      throw new Error("fee_unavailable");
    const context = isClient
      ? {
          walletVersion: "v5r1" as const,
          workchain: (contextId << 1) >> 24,
          subwalletNumber: contextId & 32767,
        }
      : contextId;
    const wallet =
      typeof context === "number"
        ? WalletContractV5R1.create<number>({
            publicKey,
            walletId: { networkGlobalId: -239, context },
          })
        : WalletContractV5R1.create({
            publicKey,
            walletId: { networkGlobalId: -239, context },
          });
    body = wallet.createTransfer(args);
  } else {
    if (!variant) throw new Error("fee_unavailable");
    body = variant.contract
      .create({
        workchain: sender.workChain,
        publicKey,
        ...(walletId === undefined ? {} : { walletId }),
      })
      .createTransfer(args);
  }
  const result = await reader.estimateExternalMessageFee(sender, {
    body,
    initCode: null,
    initData: null,
    ignoreSignature: true,
  });
  const fees = [
    result.source_fees.in_fwd_fee,
    result.source_fees.storage_fee,
    result.source_fees.gas_fee,
    result.source_fees.fwd_fee,
  ];
  if (!fees.every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("fee_unavailable");
  const nano = fees.reduce((sum, value) => sum + BigInt(value), 0n);
  if (nano <= 0n) throw new Error("fee_unavailable");
  return {
    nano: nano.toString(),
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}
