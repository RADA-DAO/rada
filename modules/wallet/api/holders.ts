import type pg from "pg";
import { createWalletBalanceReader } from "./balances.ts";

export type HolderWallet = {
  subject_id: string;
  frog_id: string;
  link_version: string;
  address: string;
};
/** Worker-only source. Never accept a wallet or subject selector from HTTP. */
export class PostgresHolderSource {
  read = createWalletBalanceReader();
  constructor(private pool: pg.Pool) {}
  async wallets(): Promise<HolderWallet[]> {
    return (
      await this.pool.query<HolderWallet>(
        "SELECT * FROM identity.holder_wallets()",
      )
    ).rows;
  }
}
