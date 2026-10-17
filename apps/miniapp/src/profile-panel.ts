import { mountProfile } from "./profile.ts";
import { mountWallet } from "./wallet.ts";
import type { initializePlatform } from "../../../packages/platform-sdk/src/index.ts";

type ProfileOptions = Parameters<typeof mountProfile>[1];
export function mountProfilePanel(
  content: HTMLElement,
  options: Pick<
    ProfileOptions,
    "locale" | "selected" | "refresh" | "openCollection"
  > & {
    platform: ReturnType<typeof initializePlatform>;
  },
): () => void {
  const { platform, ...profile } = options;
  const collection = content.querySelector<HTMLElement>(
    "[data-profile-collection]",
  );
  const wallet = content.querySelector<HTMLElement>("[data-profile-wallet]");
  const stopCollection = collection
    ? mountProfile(collection, {
        ...profile,
        artwork: (path, signal) => platform.readFrogArtwork(path, signal),
        select: (frogId, signal) => platform.selectProfileFrog(frogId, signal),
      })
    : undefined;
  const stopWallet = wallet
    ? mountWallet(wallet, profile.locale, platform)
    : undefined;
  return () => {
    stopCollection?.();
    stopWallet?.();
  };
}
