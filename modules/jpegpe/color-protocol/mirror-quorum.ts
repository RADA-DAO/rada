import {
  HttpCachingChain,
  HttpChainClient,
  fetchBeacon,
  roundAt,
  roundTime,
  type RandomnessBeacon,
} from "drand-client";
import { QUICKNET_INFO } from "./chain-info.ts";
import { verifyQuicknetBeaconOffline } from "./offline-beacon.ts";
import {
  COLOR_DERIVATION_VERSION,
  COLOR_DROP_PROTOCOL_VERSION,
  DRAND_QUICKNET_CHAIN_HASH,
  deriveColorRecord,
  type ColorClass,
  type ColorPurpose,
} from "./protocol.ts";

const QUICKNET_RELAY_BASES = [
  "https://api.drand.sh",
  "https://api2.drand.sh",
  "https://drand.cloudflare.com",
] as const;
const QUICKNET_RELAY_TIMEOUT_MS = 4_500;

const clientOptions = {
  disableBeaconVerification: false,
  noCache: true,
  chainVerificationParams: {
    chainHash: QUICKNET_INFO.hash,
    publicKey: QUICKNET_INFO.public_key,
  },
};

export type VerifiedColorProof = {
  requestId: string;
  frogId: string;
  purpose: ColorPurpose;
  chainHash: typeof DRAND_QUICKNET_CHAIN_HASH;
  round: string;
  randomness: string;
  signature: string;
  derivationVersion: typeof COLOR_DERIVATION_VERSION;
  protocolVersion: typeof COLOR_DROP_PROTOCOL_VERSION;
  taxonomyVersion: 1;
  colorHex: string;
  colorClass: ColorClass;
};

function normalizedBeacon(beacon: RandomnessBeacon): RandomnessBeacon {
  return {
    round: beacon.round,
    randomness: beacon.randomness.toLowerCase(),
    signature: beacon.signature.toLowerCase(),
  };
}

function sameBeacon(
  first: RandomnessBeacon,
  second: RandomnessBeacon,
): boolean {
  return (
    first.round === second.round &&
    first.randomness.toLowerCase() === second.randomness.toLowerCase() &&
    first.signature.toLowerCase() === second.signature.toLowerCase()
  );
}

async function fetchFromRelay(
  baseUrl: string,
  round: number,
): Promise<RandomnessBeacon> {
  const chain = new HttpCachingChain(
    `${baseUrl}/${DRAND_QUICKNET_CHAIN_HASH}`,
    clientOptions,
  );
  const client = new HttpChainClient(chain, clientOptions);
  return normalizedBeacon(await fetchBeacon(client, round));
}

async function withRelayTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("quicknet_relay_timeout"));
        }, QUICKNET_RELAY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Fetches three independent relay responses, verifies every BLS signature and
 * requires two identical verified beacons. Relay choice never adds entropy.
 */
export async function fetchVerifiedQuicknetBeacon(
  round: number,
  relayFetcher: (
    baseUrl: string,
    round: number,
  ) => Promise<RandomnessBeacon> = fetchFromRelay,
): Promise<RandomnessBeacon> {
  if (!Number.isSafeInteger(round) || round < 1)
    throw new Error("invalid_quicknet_round");
  const settled = await Promise.allSettled(
    QUICKNET_RELAY_BASES.map(async (baseUrl) => {
      const beacon = await withRelayTimeout(relayFetcher(baseUrl, round));
      if (beacon.round !== round) throw new Error("quicknet_round_mismatch");
      await verifyQuicknetBeaconOffline(beacon);
      return normalizedBeacon(beacon);
    }),
  );
  const beacons = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  for (const first of beacons) {
    const matches = beacons.filter((beacon) => sameBeacon(first, beacon));
    if (matches.length >= 2) return first;
  }
  throw new Error(
    beacons.length ? "quicknet_relay_mismatch" : "quicknet_unavailable",
  );
}

export function quicknetRoundAt(timestampMs: number): number {
  return roundAt(timestampMs, QUICKNET_INFO);
}

export function quicknetRoundTime(round: number): number {
  return roundTime(QUICKNET_INFO, round);
}

export async function buildVerifiedColorProof(input: {
  requestId: string;
  frogId: string;
  purpose: ColorPurpose;
  round: string | number;
  beacon: RandomnessBeacon;
}): Promise<VerifiedColorProof> {
  const round = String(input.round);
  if (String(input.beacon.round) !== round)
    throw new Error("quicknet_round_mismatch");
  const record = await deriveColorRecord({
    purpose: input.purpose,
    chainHash: DRAND_QUICKNET_CHAIN_HASH,
    round,
    randomness: input.beacon.randomness,
    frogId: input.frogId,
    requestId: input.requestId,
  });
  return {
    requestId: input.requestId,
    frogId: input.frogId,
    purpose: input.purpose,
    chainHash: DRAND_QUICKNET_CHAIN_HASH,
    round,
    randomness: input.beacon.randomness.toLowerCase(),
    signature: input.beacon.signature.toLowerCase(),
    derivationVersion: COLOR_DERIVATION_VERSION,
    protocolVersion: COLOR_DROP_PROTOCOL_VERSION,
    taxonomyVersion: 1,
    colorHex: record.colorHex,
    colorClass: record.colorClass,
  };
}
