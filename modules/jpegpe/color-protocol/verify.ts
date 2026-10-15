import { readFile } from "node:fs/promises";
import {
  DRAND_QUICKNET_CHAIN_HASH,
  deriveColorRecord,
  type ColorDerivationInput,
} from "./protocol.ts";
import type { RandomnessBeacon } from "drand-client";
import { verifyQuicknetBeaconOffline } from "./offline-beacon.ts";

function usage(): never {
  console.error(`Usage: node modules/jpegpe/color-protocol/verify.ts <proof.json> [--expect '#RRGGBB']

The proof JSON must contain purpose, round, randomness, signature, frogId and
requestId. chainHash is optional and defaults to pinned drand Quicknet. The
verifier checks the BLS signature, derivation and taxonomy offline.`);
  process.exit(2);
}

const proofPath = process.argv[2];
if (!proofPath || proofPath.startsWith("-")) usage();
const expectIndex = process.argv.indexOf("--expect");
const expected = expectIndex >= 0 ? process.argv[expectIndex + 1] : undefined;
if (expectIndex >= 0 && (!expected || !/^#[0-9a-f]{6}$/i.test(expected)))
  usage();
const input = JSON.parse(
  await readFile(proofPath, "utf8"),
) as ColorDerivationInput & {
  signature?: string;
};
if (!input.signature || !/^[0-9a-f]+$/i.test(input.signature)) {
  console.error(
    JSON.stringify(
      { ok: false, reason: "missing_or_invalid_signature" },
      null,
      2,
    ),
  );
  process.exit(1);
}
const beacon: RandomnessBeacon = {
  round: Number(input.round),
  randomness: input.randomness,
  signature: input.signature,
};
await verifyQuicknetBeaconOffline(beacon);
const record = await deriveColorRecord(input);
if (expected && record.colorHex !== expected.toUpperCase()) {
  console.error(
    JSON.stringify(
      { ok: false, reason: "derived_colour_mismatch", record },
      null,
      2,
    ),
  );
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      ok: true,
      derivationVerified: true,
      beaconSignatureVerified: true,
      input: {
        purpose: input.purpose,
        chainHash: input.chainHash ?? DRAND_QUICKNET_CHAIN_HASH,
        round: input.round,
        frogId: input.frogId,
        requestId: input.requestId,
      },
      result: record,
    },
    null,
    2,
  ),
);
