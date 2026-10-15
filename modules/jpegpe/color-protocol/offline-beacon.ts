import {
  fetchBeacon,
  type Chain,
  type ChainClient,
  type ChainInfo,
  type RandomnessBeacon,
} from "drand-client";
import { QUICKNET_INFO } from "./chain-info.ts";

export async function verifyQuicknetBeaconOffline(
  beacon: RandomnessBeacon,
): Promise<void> {
  if (!Number.isSafeInteger(beacon.round) || beacon.round < 1) {
    throw new Error("invalid_quicknet_round");
  }
  const chain: Chain = {
    baseUrl: "offline://quicknet",
    info: async () => QUICKNET_INFO as ChainInfo,
  };
  const client: ChainClient = {
    options: {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: {
        chainHash: QUICKNET_INFO.hash,
        publicKey: QUICKNET_INFO.public_key,
      },
    },
    chain: () => chain,
    latest: async () => beacon,
    get: async () => beacon,
  };
  await fetchBeacon(client, beacon.round);
}
