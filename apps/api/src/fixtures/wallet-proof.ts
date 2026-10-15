import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { WalletContractV4, beginCell, storeStateInit } from "@ton/ton";

/** Deterministic, unfunded fixture; signs ownership challenges only. */
export function walletProof(
  payload: string,
  domain = "wallet.fixture.example",
  seed = 7,
) {
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.alloc(32, seed),
    ]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey });
  const timestamp = Math.floor(Date.now() / 1000);
  const time = Buffer.alloc(8);
  time.writeBigUInt64LE(BigInt(timestamp));
  const domainBytes = Buffer.from(domain);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(domainBytes.length);
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(0);
  const sha = (value: Buffer) => createHash("sha256").update(value).digest();
  const digest = sha(
    Buffer.concat([
      Buffer.from([255, 255]),
      Buffer.from("ton-connect"),
      sha(
        Buffer.concat([
          Buffer.from("ton-proof-item-v2/"),
          workchain,
          wallet.address.hash,
          length,
          domainBytes,
          time,
          Buffer.from(payload),
        ]),
      ),
    ]),
  );
  return {
    address: wallet.address.toRawString(),
    network: "-239",
    walletStateInit: beginCell()
      .store(storeStateInit(wallet.init))
      .endCell()
      .toBoc()
      .toString("base64"),
    publicKey: publicKey.toString("hex"),
    proof: {
      timestamp,
      domain: { lengthBytes: domainBytes.length, value: domain },
      payload,
      signature: sign(null, digest, privateKey).toString("base64"),
    },
  };
}
