import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  Address,
  Cell,
  contractAddress,
  domainSignVerify,
  loadStateInit,
  type SignatureDomain,
  type Slice,
  type StateInit,
  WalletContractV1R1,
  WalletContractV1R2,
  WalletContractV1R3,
  WalletContractV2R1,
  WalletContractV2R2,
  WalletContractV3R1,
  WalletContractV3R2,
  WalletContractV4 as WalletContractV4R2,
  WalletContractV5R1,
} from "@ton/ton";

export type TonProofPayload = {
  timestamp: number | string;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
};

type VerifyTonProofInput = {
  address: string;
  network: string;
  walletStateInit: string;
  publicKey?: string;
  proof: TonProofPayload;
  expectedDomain: string;
  expectedPayload: string;
};

function loadV1(slice: Slice): Buffer {
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV2(slice: Slice): Buffer {
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV3(slice: Slice): Buffer {
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV4(slice: Slice): Buffer {
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

function loadV5(slice: Slice): Buffer {
  slice.loadBoolean();
  slice.loadUint(32);
  slice.loadUint(32);
  return slice.loadBuffer(32);
}

const knownWallets = [
  { contract: WalletContractV1R1, load: loadV1 },
  { contract: WalletContractV1R2, load: loadV1 },
  { contract: WalletContractV1R3, load: loadV1 },
  { contract: WalletContractV2R1, load: loadV2 },
  { contract: WalletContractV2R2, load: loadV2 },
  { contract: WalletContractV3R1, load: loadV3 },
  { contract: WalletContractV3R2, load: loadV3 },
  { contract: WalletContractV4R2, load: loadV4 },
  { contract: WalletContractV5R1, load: loadV5 },
].map(({ contract, load }) => ({
  code: contract.create({ workchain: 0, publicKey: Buffer.alloc(32) }).init
    .code,
  load,
}));

// Official immutable Telegram Wallet trampoline, pinned to:
// https://github.com/ton-blockchain/tg-wallet-contract/tree/1a29ae5d90e03c3d585d3e42e6ecef691d727a3c
// contracts/WalletTrampoline.boc and contracts/WalletTg/storage.tolk (revision 0).
// Unlike v1–v5, this contract supports key rotation: its genesis key must never
// authenticate an active account without checking the current on-chain key.
const telegramWalletCode = Cell.fromBase64(
  "te6cckEBAQEAGgAAMP8AIJgh10mDCLnyQN+Ahfgz0O0eIO1T2WlCfjk=",
);
const keyLookupTimeoutMs = 4_000;
async function limitedJson(response: Response): Promise<unknown> {
  if (!response.ok) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 64_000) {
        await reader.cancel();
        return null;
      }
      chunks.push(item.value);
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function getTelegramWalletPublicKey(
  address: string,
): Promise<Buffer | null> {
  try {
    const response = await fetch(
      `https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(address)}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(keyLookupTimeoutMs),
        cache: "no-store",
        redirect: "error",
      },
    );
    if (!response.ok) return null;
    const payload = (await limitedJson(response)) as {
      ok?: unknown;
      result?: { state?: unknown; code?: unknown };
    };
    if (payload?.ok !== true) return null;
    if (
      payload.result?.state !== "active" ||
      typeof payload.result.code !== "string"
    )
      return null;
    const activeCode = Cell.fromBase64(payload.result.code);
    if (!activeCode.hash().equals(telegramWalletCode.hash())) return null;
    return getOnChainPublicKey(address);
  } catch {
    return null;
  }
}

function tryExtractPublicKey(stateInit: StateInit): Buffer | null {
  if (!stateInit.code || !stateInit.data) return null;
  for (const wallet of knownWallets) {
    try {
      if (wallet.code.equals(stateInit.code))
        return wallet.load(stateInit.data.beginParse());
    } catch {
      // Unknown layout; try the next standard wallet contract.
    }
  }
  return null;
}

async function getOnChainPublicKey(address: string): Promise<Buffer | null> {
  try {
    const response = await fetch("https://toncenter.com/api/v2/runGetMethod", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ address, method: "get_public_key", stack: [] }),
      signal: AbortSignal.timeout(keyLookupTimeoutMs),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) return null;
    const payload: unknown = await limitedJson(response);
    if (typeof payload !== "object" || payload === null) return null;
    const body = payload as {
      ok?: unknown;
      result?: { exit_code?: unknown; stack?: unknown };
    };
    if (
      body.ok !== true ||
      (body.result?.exit_code !== 0 && body.result?.exit_code !== 1)
    )
      return null;
    const stack = body.result.stack;
    if (
      !Array.isArray(stack) ||
      stack.length !== 1 ||
      !Array.isArray(stack[0]) ||
      stack[0].length !== 2 ||
      stack[0][0] !== "num" ||
      typeof stack[0][1] !== "string" ||
      !/^(?:0x[\da-f]+|\d+)$/i.test(stack[0][1])
    )
      return null;
    const value = BigInt(stack[0][1]);
    if (value < 0n || value >= 1n << 256n) return null;
    const hex = value.toString(16).padStart(64, "0");
    return hex.length === 64 ? Buffer.from(hex, "hex") : null;
  } catch {
    return null;
  }
}

function sha256(value: Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

function signatureDomain(network: string): SignatureDomain {
  return network === "-239" || network === "-3"
    ? { type: "empty" }
    : { type: "l2", globalId: Number(network) };
}

function buildTonProofDigest(
  address: Address,
  proof: TonProofPayload,
  proofTimestamp: number,
): Buffer {
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workChain, 0);
  const domainBytes = Buffer.from(proof.domain.value, "utf8");
  if (proof.domain.lengthBytes !== domainBytes.length)
    throw new Error("domain_length_mismatch");
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(proof.domain.lengthBytes, 0);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE(BigInt(proofTimestamp), 0);
  const message = Buffer.concat([
    Buffer.from("ton-proof-item-v2/", "utf8"),
    workchain,
    Buffer.from(address.hash),
    domainLength,
    domainBytes,
    timestamp,
    Buffer.from(proof.payload, "utf8"),
  ]);
  return sha256(
    Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from("ton-connect", "utf8"),
      sha256(message),
    ]),
  );
}

export async function verifyTonProof(
  input: VerifyTonProofInput,
): Promise<Address> {
  if (input.network !== "-239") throw new Error("wrong_network");
  if (input.proof.domain.value !== input.expectedDomain)
    throw new Error("wrong_domain");
  if (input.proof.payload !== input.expectedPayload)
    throw new Error("wrong_payload");
  const timestamp =
    typeof input.proof.timestamp === "string"
      ? /^(0|[1-9][0-9]*)$/.test(input.proof.timestamp)
        ? Number(input.proof.timestamp)
        : NaN
      : input.proof.timestamp;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0)
    throw new Error("invalid_timestamp");
  const now = Math.floor(Date.now() / 1_000);
  if (timestamp < now - 10 * 60 || timestamp > now + 120)
    throw new Error("proof_expired");
  if (
    Buffer.byteLength(input.proof.domain.value, "utf8") > 128 ||
    Buffer.byteLength(input.proof.payload, "utf8") > 128 ||
    Buffer.byteLength(input.proof.domain.value + input.proof.payload, "utf8") >
      222
  )
    throw new Error("proof_too_large");

  if (!/^0:[0-9a-f]{64}$/i.test(input.address))
    throw new Error("invalid_address");
  const address = Address.parse(input.address);
  const stateInit = loadStateInit(
    Cell.fromBase64(input.walletStateInit).beginParse(),
  );
  const derivedAddress = contractAddress(address.workChain, stateInit);
  if (!derivedAddress.equals(address)) throw new Error("state_init_mismatch");

  const publicKey = stateInit.code?.equals(telegramWalletCode)
    ? await getTelegramWalletPublicKey(input.address)
    : tryExtractPublicKey(stateInit);
  if (!publicKey || publicKey.length !== 32)
    throw new Error("public_key_unavailable");
  if (
    input.publicKey !== undefined &&
    (!/^[0-9a-f]{64}$/i.test(input.publicKey) ||
      !publicKey.equals(Buffer.from(input.publicKey, "hex")))
  )
    throw new Error("public_key_mismatch");
  const signature = Buffer.from(input.proof.signature, "base64");
  if (
    !/^[A-Za-z0-9+/]{86}==$/.test(input.proof.signature) ||
    signature.length !== 64
  )
    throw new Error("invalid_signature");
  const valid = domainSignVerify({
    data: buildTonProofDigest(address, input.proof, timestamp),
    signature,
    publicKey,
    domain: signatureDomain(input.network),
  });
  if (!valid) throw new Error("bad_signature");
  return address;
}
