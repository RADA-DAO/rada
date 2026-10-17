import type {
  HolderWallet,
  createWalletBalanceReader,
} from "../../wallet/index.ts";
export type HolderSource = {
  wallets(): Promise<HolderWallet[]>;
  read: ReturnType<typeof createWalletBalanceReader>;
};
export type Sample = { token: "TON" | "JPEGPE"; amount: string; asOf: string };
export interface ProjectionSink {
  prune(): Promise<void>;
  record(holder: HolderWallet, sample: Sample): Promise<void>;
}
/** Unknown values never become zero or a partial multi-wallet total. */
export async function refreshHolders(
  source: HolderSource,
  sink: ProjectionSink,
  pause: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 2000)),
) {
  await sink.prune();
  const groups = new Map<string, HolderWallet[]>();
  for (const wallet of await source.wallets()) {
    const group = groups.get(wallet.subject_id) ?? [];
    group.push(wallet);
    groups.set(wallet.subject_id, group);
  }
  for (const wallets of groups.values()) {
    const totals = { TON: 0n, JPEGPE: 0n };
    const dates: Record<string, string[]> = { TON: [], JPEGPE: [] };
    for (const wallet of wallets) {
      await pause();
      try {
        const balances = await source.read(wallet.address);
        for (const token of ["TON", "JPEGPE"] as const) {
          const value = token === "TON" ? balances.gram : balances.jpegpe;
          if (value && balances.balancesUpdatedAt) {
            totals[token] += BigInt(value.raw);
            dates[token]!.push(balances.balancesUpdatedAt);
          }
        }
      } catch {
        /* Retain the last complete sample on provider failure. */
      }
    }
    for (const token of ["TON", "JPEGPE"] as const) {
      if (dates[token]!.length === wallets.length)
        await sink.record(wallets[0]!, {
          token,
          amount: totals[token].toString(),
          asOf: dates[token]!.sort()[0]!,
        });
    }
  }
  await sink.prune();
}
