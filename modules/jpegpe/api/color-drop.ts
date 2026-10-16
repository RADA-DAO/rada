import type { RandomnessBeacon } from "drand-client";
import {
  buildVerifiedColorProof,
  fetchVerifiedQuicknetBeacon,
  quicknetRoundAt,
  type VerifiedColorProof,
} from "../color-protocol/mirror-quorum.ts";

/** Background and accent of one frog, both from one committed Quicknet round. */
export type ColorDrop = {
  background: VerifiedColorProof;
  accent: VerifiedColorProof;
};

/**
 * The first Quicknet round published strictly after `afterMs`, so nobody can
 * know its randomness at that moment (e.g. when a payment is signed).
 */
export function committedColorRound(afterMs: number): number {
  return quicknetRoundAt(afterMs) + 1;
}

/**
 * Colour Drop v1 for a new frog: fetches the round's beacon from the pinned
 * relay quorum (two matching BLS-verified answers) and derives both colours.
 * Fails while the round is not published yet or the relays disagree.
 */
export async function drawFrogColors(
  input: { frogId: string; requestId: string; round: number },
  fetchBeacon: (
    round: number,
  ) => Promise<RandomnessBeacon> = fetchVerifiedQuicknetBeacon,
): Promise<ColorDrop> {
  const beacon = await fetchBeacon(input.round);
  const proof = (purpose: "background" | "accent") =>
    buildVerifiedColorProof({ ...input, purpose, beacon });
  return {
    background: await proof("background"),
    accent: await proof("accent"),
  };
}
