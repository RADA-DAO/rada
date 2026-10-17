import pg from "pg";
import { randomBytes } from "node:crypto";
import { resolveTelegramSubject } from "../../identity/index.ts";
import { verifyTonProof, type TonProofPayload } from "./ton-proof.ts";
import { createWalletBalanceReader, type Balances } from "./balances.ts";
import { Address } from "@ton/ton";

export type OwnWallet = {
  address: string;
  network: "-239";
  verifiedAt: string;
};
export type WalletBalance = { address: string; balances: Balances };
export type WalletEvent = {
  address: string;
  action: "linked" | "revoked";
  occurredAt: string;
};
export type WalletLinkRequest = {
  address: string;
  network: string;
  walletStateInit: string;
  publicKey?: string;
  proof: TonProofPayload;
};
export interface WalletStore {
  challenge(
    telegramId: string,
  ): Promise<{ payload: string; expiresAt: string }>;
  link(telegramId: string, input: WalletLinkRequest): Promise<OwnWallet>;
  own(telegramId: string): Promise<OwnWallet[]>;
  history(telegramId: string): Promise<WalletEvent[]>;
  revoke(telegramId: string, address: string): Promise<boolean>;
  appAddress(telegramId: string, appId: string): Promise<OwnWallet[] | null>;
  appBalances(
    telegramId: string,
    appId: string,
  ): Promise<WalletBalance[] | null>;
  ownBalances(telegramId: string): Promise<WalletBalance[]>;
}

type WalletRow = {
  address_raw: string;
  address_friendly: string;
  network: "-239";
  verified_at: Date;
};

export class PostgresWalletStore implements WalletStore {
  private readBalances = createWalletBalanceReader();
  private readonly auth: pg.Pool;
  private readonly service: pg.Pool;
  private readonly domain: string;
  constructor(auth: pg.Pool, service: pg.Pool, domain: string) {
    this.auth = auth;
    this.service = service;
    this.domain = domain;
  }
  private async transaction<T>(
    telegramId: string,
    run: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const subject = await resolveTelegramSubject(this.auth, telegramId);
    const client = await this.service.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('rada.subject_id', $1, true)", [
        subject,
      ]);
      const value = await run(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async challenge(telegramId: string) {
    return await this.transaction(telegramId, async (client) => {
      const payload = randomBytes(32).toString("hex");
      await client.query(
        "UPDATE wallet.challenges SET consumed_at = now() WHERE subject_id = identity.current_subject() AND consumed_at IS NULL",
      );
      const result = await client.query<{ expires_at: Date }>(
        `INSERT INTO wallet.challenges(payload, subject_id, domain, expires_at)
         VALUES ($1, identity.current_subject(), $2, now() + interval '10 minutes') RETURNING expires_at`,
        [payload, this.domain],
      );
      const row = result.rows[0];
      if (!row) throw new Error("unavailable");
      return { payload, expiresAt: row.expires_at.toISOString() };
    });
  }
  async link(telegramId: string, input: WalletLinkRequest): Promise<OwnWallet> {
    return await this.transaction(telegramId, async (client) => {
      const challenge = await client.query<{ domain: string }>(
        `SELECT domain FROM wallet.challenges WHERE payload = $1
          AND subject_id = identity.current_subject() AND consumed_at IS NULL
          AND expires_at > now() FOR UPDATE`,
        [input.proof.payload],
      );
      const issued = challenge.rows[0];
      if (challenge.rowCount !== 1 || !issued)
        throw new Error("challenge_expired");
      const address = await verifyTonProof({
        ...input,
        expectedDomain: issued.domain,
        expectedPayload: input.proof.payload,
      });
      const raw = address.toRawString();
      const friendly = address.toString({
        bounceable: false,
        testOnly: false,
        urlSafe: true,
      });
      await client.query("SELECT identity.wallet_link($1, $2)", [
        raw,
        friendly,
      ]);
      await client.query(
        "UPDATE wallet.challenges SET consumed_at = now() WHERE payload = $1",
        [input.proof.payload],
      );
      const wallet = (await this.readOwn(client)).find(
        (item) => item.address === friendly,
      );
      if (!wallet) throw new Error("unavailable");
      return wallet;
    });
  }
  private async readOwn(client: pg.PoolClient): Promise<OwnWallet[]> {
    const result = await client.query<WalletRow>(
      "SELECT * FROM identity.own_wallet()",
    );
    return result.rows.map((row) => ({
      address: row.address_friendly,
      network: row.network,
      verifiedAt: row.verified_at.toISOString(),
    }));
  }
  async own(telegramId: string) {
    return await this.transaction(telegramId, (client) => this.readOwn(client));
  }
  async history(telegramId: string) {
    return await this.transaction(telegramId, async (client) => {
      const result = await client.query<{
        address_raw: string;
        action: "linked" | "revoked";
        occurred_at: Date;
      }>("SELECT * FROM identity.own_wallet_history()");
      return result.rows.map((row) => ({
        address: row.address_raw,
        action: row.action,
        occurredAt: row.occurred_at.toISOString(),
      }));
    });
  }
  async revoke(telegramId: string, address: string) {
    const raw = Address.parse(address).toRawString();
    return await this.transaction(telegramId, async (client) => {
      const result = await client.query<{ revoked: boolean }>(
        "SELECT identity.wallet_revoke($1) AS revoked",
        [raw],
      );
      return result.rows[0]?.revoked ?? false;
    });
  }
  private async appWallet(
    telegramId: string,
    appId: string,
    capability: string,
  ) {
    return await this.transaction(telegramId, async (client) => {
      const consent = await client.query<{ granted: boolean }>(
        "SELECT identity.wallet_consent($1, $2) AS granted",
        [appId, capability],
      );
      return consent.rows[0]?.granted ? this.readOwn(client) : null;
    });
  }
  async appAddress(telegramId: string, appId: string) {
    return await this.appWallet(telegramId, appId, "wallet.address.read");
  }
  async appBalances(telegramId: string, appId: string) {
    const wallet = await this.appWallet(
      telegramId,
      appId,
      "wallet.balances.read",
    );
    return wallet
      ? Promise.all(
          wallet.map(async (item) => ({
            address: item.address,
            balances: await this.readBalances(item.address, item.network),
          })),
        )
      : null;
  }
  async ownBalances(telegramId: string) {
    const wallet = await this.own(telegramId);
    return Promise.all(
      wallet.map(async (item) => ({
        address: item.address,
        balances: await this.readBalances(item.address, item.network),
      })),
    );
  }
}
