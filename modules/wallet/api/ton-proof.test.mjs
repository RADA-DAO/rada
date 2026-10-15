import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  WalletContractV4,
  beginCell,
  contractAddress,
  storeStateInit,
  Cell,
} from "@ton/ton";
import { verifyTonProof } from "./ton-proof.ts";

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 7),
  ]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey)
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const init = WalletContractV4.create({ workchain: 0, publicKey }).init;
const rotatedPrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.alloc(32, 8),
  ]),
  format: "der",
  type: "pkcs8",
});
const rotatedPublicKey = createPublicKey(rotatedPrivateKey)
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const telegramCode = Cell.fromBase64(
  "te6cckEBAQEAGgAAMP8AIJgh10mDCLnyQN+Ahfgz0O0eIO1T2WlCfjk=",
);
const telegramInit = {
  code: telegramCode,
  data: beginCell()
    .storeUint(0, 8)
    .storeUint(0, 32)
    .storeUint(0x7fff7f11, 32)
    .storeBuffer(publicKey)
    .endCell(),
};
function proofFor(state = init, signer = { privateKey, publicKey }) {
  const address = contractAddress(0, state);
  const domain = Buffer.from("app.test");
  const timestamp = Math.floor(Date.now() / 1000);
  const time = Buffer.alloc(8);
  time.writeBigUInt64LE(BigInt(timestamp));
  const length = Buffer.alloc(4);
  length.writeUInt32LE(domain.length);
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(0);
  const payload = "a".repeat(64);
  const sha = (value) => createHash("sha256").update(value).digest();
  const digest = sha(
    Buffer.concat([
      Buffer.from([255, 255]),
      Buffer.from("ton-connect"),
      sha(
        Buffer.concat([
          Buffer.from("ton-proof-item-v2/"),
          wc,
          address.hash,
          length,
          domain,
          time,
          Buffer.from(payload),
        ]),
      ),
    ]),
  );
  return {
    address: address.toRawString(),
    network: "-239",
    walletStateInit: beginCell()
      .store(storeStateInit(state))
      .endCell()
      .toBoc()
      .toString("base64"),
    publicKey: signer.publicKey.toString("hex"),
    proof: {
      timestamp,
      domain: { lengthBytes: domain.length, value: domain.toString() },
      payload,
      signature: sign(null, digest, signer.privateKey).toString("base64"),
    },
    expectedDomain: domain.toString(),
    expectedPayload: payload,
  };
}

test("valid standard wallet proof binds address, domain, nonce and trusted key", async () => {
  const input = proofFor();
  assert.equal((await verifyTonProof(input)).toRawString(), input.address);
  for (const change of [
    { address: "0:" + "1".repeat(64) },
    { expectedDomain: "evil.test" },
    { expectedPayload: "b".repeat(64) },
    { publicKey: "0".repeat(64) },
    { publicKey: "" },
    { network: "-3" },
    {
      proof: { ...input.proof, timestamp: String(input.proof.timestamp + 300) },
    },
    {
      proof: { ...input.proof, signature: Buffer.alloc(64).toString("base64") },
    },
  ])
    await assert.rejects(verifyTonProof({ ...input, ...change }));
  assert.equal(
    (
      await verifyTonProof({
        ...input,
        proof: { ...input.proof, timestamp: String(input.proof.timestamp) },
      })
    ).toRawString(),
    input.address,
  );
});

test("active WalletTg verifies current key only after matching on-chain code", async (t) => {
  const active = {
    ok: true,
    result: { state: "active", code: telegramCode.toBoc().toString("base64") },
  };
  const getter = {
    ok: true,
    result: {
      exit_code: 0,
      stack: [["num", `0x${rotatedPublicKey.toString("hex")}`]],
    },
  };
  const replies = [active, getter, active, getter];
  const calls = t.mock.method(globalThis, "fetch", (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.cache, "no-store");
    assert.equal(options.redirect, "error");
    return Promise.resolve(Response.json(replies.shift()));
  });
  const current = proofFor(telegramInit, {
    privateKey: rotatedPrivateKey,
    publicKey: rotatedPublicKey,
  });
  assert.equal((await verifyTonProof(current)).toRawString(), current.address);
  await assert.rejects(
    verifyTonProof(proofFor(telegramInit)),
    /public_key_mismatch/,
  );
  assert.equal(calls.mock.callCount(), 4);
});

test("WalletTg inactive, code mismatch or getter failure fails closed", async (t) => {
  const code = telegramCode.toBoc().toString("base64");
  const replies = [
    { ok: true, result: { state: "uninitialized", code } },
    {
      ok: true,
      result: { state: "active", code: Cell.EMPTY.toBoc().toString("base64") },
    },
    { ok: true, result: { state: "active", code } },
    { ok: true, result: { exit_code: -13, stack: [] } },
  ];
  const calls = t.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json(replies.shift())),
  );
  for (let index = 0; index < 3; index++)
    await assert.rejects(
      verifyTonProof(proofFor(telegramInit)),
      /public_key_unavailable/,
    );
  assert.equal(calls.mock.callCount(), 4);
});

test("unknown wallet code is rejected without trusting its advertised key", async (t) => {
  const calls = t.mock.method(globalThis, "fetch", () => {
    return Promise.reject(Error("unexpected RPC"));
  });
  const other = {
    code: beginCell().storeUint(123, 16).endCell(),
    data: Cell.EMPTY,
  };
  await assert.rejects(
    verifyTonProof(proofFor(other)),
    /public_key_unavailable/,
  );
  assert.equal(calls.mock.callCount(), 0);
});
