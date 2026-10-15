import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import type { RandomnessBeacon } from "drand-client";
import {
  COLOR_DERIVATION_VERSION,
  COLOR_PURPOSE_CODES,
  DRAND_QUICKNET_CHAIN_HASH,
  buildColorDerivationInput,
  classifyHex,
  classifyHexFaction,
  colorClassToFaction,
  deriveColorRecord,
  EXPECTED_FACTION_POPULATIONS,
  hexToOklch,
} from "./protocol.ts";
import { fetchVerifiedQuicknetBeacon } from "./mirror-quorum.ts";
import { verifyQuicknetBeaconOffline } from "./offline-beacon.ts";

type ProofFixture = {
  purpose: "background" | "accent";
  chainHash: string;
  round: number;
  randomness: string;
  signature: string;
  frogId: string;
  requestId: string;
};

const background = JSON.parse(
  await readFile(
    "modules/jpegpe/color-protocol/fixtures/background-proof-v1.json",
    "utf8",
  ),
) as ProofFixture;
const accent = JSON.parse(
  await readFile(
    "modules/jpegpe/color-protocol/fixtures/accent-proof-v1.json",
    "utf8",
  ),
) as ProofFixture;

const expectedClasses: Record<string, string> = {
  "#000000": "NEUTRAL_DARK",
  "#808080": "NEUTRAL_GRAY",
  "#FFFFFF": "NEUTRAL_LIGHT",
  "#FF0000": "CHROMATIC_RED",
  "#FFFF00": "CHROMATIC_YELLOW",
  "#00FF00": "CHROMATIC_GREEN",
  "#00FFFF": "CHROMATIC_CYAN",
  "#0000FF": "CHROMATIC_BLUE",
  "#FF00FF": "CHROMATIC_MAGENTA",
};
for (const [hex, colorClass] of Object.entries(expectedClasses)) {
  assert.equal(classifyHex(hex), colorClass, `${hex} class compatibility`);
}
for (const [hex, faction] of Object.entries({
  "#000000": "NEUTRAL",
  "#808080": "NEUTRAL",
  "#FFFFFF": "NEUTRAL",
  "#FF0000": "CHROMATIC_RED",
  "#FFFF00": "CHROMATIC_YELLOW",
  "#00FF00": "CHROMATIC_GREEN",
  "#00FFFF": "CHROMATIC_CYAN",
  "#0000FF": "CHROMATIC_BLUE",
  "#FF00FF": "CHROMATIC_MAGENTA",
})) {
  assert.equal(classifyHexFaction(hex), faction, `${hex} faction mapping`);
}
for (const neutral of [
  "NEUTRAL_DARK",
  "NEUTRAL_GRAY",
  "NEUTRAL_LIGHT",
] as const) {
  assert.equal(colorClassToFaction(neutral), "NEUTRAL");
}
assert.equal(EXPECTED_FACTION_POPULATIONS.NEUTRAL, 165_020);

const boundaryFixtures: Array<readonly [string, string, string]> = [
  ["neutral chroma -", "#A296A0", "NEUTRAL_GRAY"],
  ["neutral chroma +", "#45483C", "CHROMATIC_YELLOW"],
  ["neutral dark lightness -", "#212121", "NEUTRAL_DARK"],
  ["neutral dark lightness +", "#222222", "NEUTRAL_GRAY"],
  ["neutral light lightness -", "#EEEEEE", "NEUTRAL_GRAY"],
  ["neutral light lightness +", "#EFEFEF", "NEUTRAL_LIGHT"],
  ["redEnd -", "#EB8735", "CHROMATIC_RED"],
  ["redEnd +", "#DF760B", "CHROMATIC_YELLOW"],
  ["yellowEnd -", "#D4EAC1", "CHROMATIC_YELLOW"],
  ["yellowEnd +", "#C3FD88", "CHROMATIC_GREEN"],
  ["greenEnd -", "#3BB36F", "CHROMATIC_GREEN"],
  ["greenEnd +", "#1A7343", "CHROMATIC_CYAN"],
  ["cyanEnd -", "#1A9FFB", "CHROMATIC_CYAN"],
  ["cyanEnd +", "#20A0FB", "CHROMATIC_BLUE"],
  ["blueEnd -", "#7545B7", "CHROMATIC_BLUE"],
  ["blueEnd +", "#4E2084", "CHROMATIC_MAGENTA"],
  ["magentaEnd -", "#FE7DBF", "CHROMATIC_MAGENTA"],
  ["magentaEnd +", "#E13D9B", "CHROMATIC_RED"],
];
for (const [label, hex, colorClass] of boundaryFixtures) {
  assert.equal(classifyHex(hex), colorClass, `${label} compatibility fixture`);
}
assert.equal(hexToOklch("#000000").c, 0);
assert.throws(() => classifyHex("#12345"), /invalid HEX/);

const vector = {
  purpose: "background" as const,
  chainHash: DRAND_QUICKNET_CHAIN_HASH,
  round: 31_115_313,
  randomness: background.randomness,
  frogId: background.frogId,
  requestId: background.requestId,
};
const first = await deriveColorRecord(vector);
assert.deepEqual(
  await deriveColorRecord(vector),
  first,
  "proof derivation must be repeatable",
);
assert.equal(first.algorithmVersion, COLOR_DERIVATION_VERSION);
assert.equal(
  first.colorHex,
  "#303CBB",
  "issued background proof result is frozen",
);
assert.equal(first.colorClass, "CHROMATIC_BLUE");
const second = await deriveColorRecord({ ...vector, purpose: "accent" });
assert.equal(
  second.colorHex,
  "#C5AA5D",
  "issued accent proof result is frozen",
);
assert.equal(second.colorClass, "CHROMATIC_YELLOW");
assert.notEqual(second.colorHex, first.colorHex);
const backgroundBytes = buildColorDerivationInput(vector);
const accentBytes = buildColorDerivationInput({ ...vector, purpose: "accent" });
const purposeOffset =
  new TextEncoder().encode(COLOR_DERIVATION_VERSION).length + 1;
assert.equal(backgroundBytes.length, 121);
assert.equal(backgroundBytes[purposeOffset], COLOR_PURPOSE_CODES.background);
assert.equal(accentBytes[purposeOffset], COLOR_PURPOSE_CODES.accent);
assert.deepEqual(
  [...backgroundBytes].filter((_byte, index) => index !== purposeOffset),
  [...accentBytes].filter((_byte, index) => index !== purposeOffset),
);
await assert.rejects(
  deriveColorRecord({ ...vector, chainHash: "00".repeat(32) }),
  /pinned drand Quicknet/,
);

const beacon: RandomnessBeacon = {
  round: background.round,
  randomness: background.randomness,
  signature: background.signature,
};
await verifyQuicknetBeaconOffline(beacon);
await verifyQuicknetBeaconOffline({
  ...beacon,
  randomness: accent.randomness,
  signature: accent.signature,
  round: accent.round,
});
await assert.rejects(
  verifyQuicknetBeaconOffline({ ...beacon, signature: "00".repeat(48) }),
  /signature|beacon|verification/i,
  "invalid BLS signatures must be rejected offline",
);
await assert.rejects(
  verifyQuicknetBeaconOffline({ ...beacon, randomness: "00".repeat(32) }),
  /randomness|signature|beacon|verification/i,
  "a corrupted randomness value must not verify against the issued signature",
);

const sameFixture = () => Promise.resolve({ ...beacon });
await assert.rejects(
  fetchVerifiedQuicknetBeacon(background.round + 1, sameFixture),
  /quicknet_unavailable/,
  "valid signatures for a different round cannot reach quorum",
);
const quorum = await fetchVerifiedQuicknetBeacon(
  background.round,
  async (url) => {
    if (url === "https://api.drand.sh") throw new Error("mock relay failure");
    return sameFixture();
  },
);
assert.deepEqual(
  quorum,
  beacon,
  "one relay failure plus two matching verified mirrors reaches quorum",
);

const invalidBeacon = { ...beacon, signature: "00".repeat(48) };
await assert.rejects(
  fetchVerifiedQuicknetBeacon(background.round, () =>
    Promise.resolve(invalidBeacon),
  ),
  /quicknet_unavailable/,
  "two identical invalid relay responses must never satisfy quorum",
);
const partialQuorum = await fetchVerifiedQuicknetBeacon(
  background.round,
  (url) =>
    Promise.resolve(url === "https://api.drand.sh" ? invalidBeacon : beacon),
);
assert.deepEqual(
  partialQuorum,
  beacon,
  "one invalid relay plus two matching valid mirrors reaches quorum",
);
await assert.rejects(
  fetchVerifiedQuicknetBeacon(background.round, (url) =>
    Promise.resolve(url === "https://api.drand.sh" ? beacon : invalidBeacon),
  ),
  /quicknet_relay_mismatch/,
  "one valid relay without a matching verified mirror has no quorum",
);

assert.equal(
  accent.frogId,
  background.frogId,
  "fixtures retain paired synthetic proof identity",
);
assert.equal(accent.requestId, background.requestId);
process.stdout.write(
  "JPEGPE color protocol compatibility, offline BLS and mirror quorum checks passed\n",
);
