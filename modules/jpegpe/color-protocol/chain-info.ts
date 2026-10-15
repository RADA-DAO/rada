import type { ChainInfo } from "drand-client";
import { DRAND_QUICKNET_CHAIN_HASH } from "./protocol.ts";

export const QUICKNET_INFO: Readonly<ChainInfo> = {
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  period: 3,
  genesis_time: 1_692_803_367,
  hash: DRAND_QUICKNET_CHAIN_HASH,
  groupHash: "f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e",
  schemeID: "bls-unchained-g1-rfc9380",
  metadata: { beaconID: "quicknet" },
};
