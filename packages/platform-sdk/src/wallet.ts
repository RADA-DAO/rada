export type LinkedWallet = {
  address: string;
  network: "-239";
  verifiedAt: string;
};
export type WalletBalances = {
  address: string;
  balances: {
    gram: { raw: string; decimals: 9; formatted: string } | null;
    jpegpe: { raw: string; decimals: 9; formatted: string } | null;
    balancesUpdatedAt: string | null;
  };
};
export type WalletProof = {
  address: string;
  network: string;
  walletStateInit: string;
  publicKey?: string;
  proof: {
    timestamp: number | string;
    domain: { lengthBytes: number; value: string };
    payload: string;
    signature: string;
  };
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("unavailable");
  return value as Record<string, unknown>;
}
function walletArray(value: unknown): unknown[] {
  const wallets = record(value).wallets;
  if (!Array.isArray(wallets) || wallets.length > 16)
    throw new Error("unavailable");
  return wallets;
}
// TON user-friendly format: tag, workchain, 32-byte hash, CRC16-XMODEM.
function addressKey(value: string): string {
  if (/^0:[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(value)) throw new Error("unavailable");
  const bytes = Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (byte) => byte.charCodeAt(0),
  );
  if ((bytes[0] !== 0x11 && bytes[0] !== 0x51) || bytes[1] !== 0)
    throw new Error("unavailable");
  let checksum = 0;
  for (const byte of bytes.subarray(0, 34)) {
    checksum ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      checksum = ((checksum << 1) ^ (checksum & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  if (checksum !== (((bytes[34] ?? 0) << 8) | (bytes[35] ?? 0)))
    throw new Error("unavailable");
  return (
    "0:" +
    Array.from(bytes.subarray(2, 34), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("")
  );
}
function address(value: unknown): string {
  if (typeof value !== "string") throw new Error("unavailable");
  try {
    addressKey(value);
  } catch {
    throw new Error("unavailable");
  }
  return value;
}
function timestamp(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("unavailable");
  return value;
}
function amount(
  value: unknown,
): { raw: string; decimals: 9; formatted: string } | null {
  if (value === null) return null;
  const item = record(value);
  if (
    typeof item.raw !== "string" ||
    !/^(0|[1-9]\d{0,79})$/.test(item.raw) ||
    item.decimals !== 9 ||
    typeof item.formatted !== "string"
  )
    throw new Error("unavailable");
  const padded = item.raw.padStart(10, "0");
  const fraction = padded.slice(-9).replace(/0+$/, "");
  const formatted = padded.slice(0, -9) + (fraction ? `.${fraction}` : "");
  if (item.formatted !== formatted) throw new Error("unavailable");
  return { raw: item.raw, decimals: 9, formatted };
}
function linkedWallet(value: unknown): LinkedWallet {
  const item = record(value);
  if (item.network !== "-239") throw new Error("unavailable");
  return {
    address: address(item.address),
    network: "-239",
    verifiedAt: timestamp(item.verifiedAt),
  };
}
function balances(value: unknown): WalletBalances["balances"] {
  const item = record(value);
  const gram = amount(item.gram);
  const jpegpe = amount(item.jpegpe);
  const balancesUpdatedAt =
    item.balancesUpdatedAt === null ? null : timestamp(item.balancesUpdatedAt);
  return { gram, jpegpe, balancesUpdatedAt };
}
function uniqueAddresses(wallets: { address: string }[]): void {
  if (
    new Set(wallets.map((wallet) => addressKey(wallet.address))).size !==
    wallets.length
  )
    throw new Error("unavailable");
}

export function walletAdapter(
  profileUrl: string,
  authHeaders: () => { Authorization: string } | null,
) {
  const base = `${profileUrl}/wallet`;
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers = authHeaders();
    if (!headers) throw new Error("expired");
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? null,
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "expired"
          : response.status === 409
            ? "stale"
            : "unavailable",
      );
    return response.json();
  }
  return {
    async readOwnWallets(signal?: AbortSignal): Promise<LinkedWallet[]> {
      const wallets = walletArray(
        await request("", "GET", undefined, signal),
      ).map(linkedWallet);
      uniqueAddresses(wallets);
      return wallets;
    },
    async readOwnWalletBalances(
      signal?: AbortSignal,
    ): Promise<WalletBalances[]> {
      const wallets = walletArray(
        await request("/balances", "GET", undefined, signal),
      ).map((value) => {
        const item = record(value);
        return {
          address: address(item.address),
          balances: balances(item.balances),
        };
      });
      uniqueAddresses(wallets);
      return wallets;
    },
    async issueWalletChallenge(signal?: AbortSignal): Promise<string> {
      const value = record(
        await request("/challenge", "POST", undefined, signal),
      );
      if (
        typeof value.payload !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.payload)
      )
        throw new Error("unavailable");
      return value.payload;
    },
    async linkWallet(input: WalletProof, signal?: AbortSignal): Promise<void> {
      const value = record(await request("/link", "POST", input, signal));
      linkedWallet(value.wallet);
    },
    async revokeWallet(address: string, signal?: AbortSignal): Promise<void> {
      const value = record(
        await request("/revoke", "POST", { address }, signal),
      );
      if (value.revoked !== true) throw new Error("stale");
    },
    async readAppWalletAddress(
      appId: string,
      signal?: AbortSignal,
    ): Promise<unknown> {
      return appRead(appId, "address", signal);
    },
    async readAppWalletBalances(
      appId: string,
      signal?: AbortSignal,
    ): Promise<unknown> {
      return appRead(appId, "balances", signal);
    },
  };
  async function appRead(
    appId: string,
    type: "address" | "balances",
    signal?: AbortSignal,
  ) {
    if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(appId))
      throw new Error("invalid_request");
    const headers = authHeaders();
    if (!headers) throw new Error("expired");
    const apiBase = profileUrl.slice(0, -3);
    const response = await fetch(
      `${apiBase}/apps/${encodeURIComponent(appId)}/wallet/${type}`,
      {
        headers,
        signal: signal ?? null,
        credentials: "omit",
        cache: "no-store",
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "expired"
          : response.status === 403
            ? "capability_denied"
            : "unavailable",
      );
    const value: unknown = await response.json();
    if (type === "address") {
      const wallets = walletArray(value).map((entry) => {
        const item = record(entry);
        if (item.network !== "-239") throw new Error("unavailable");
        return { address: address(item.address), network: "-239" as const };
      });
      uniqueAddresses(wallets);
      return { wallets };
    }
    return {
      wallets: walletArray(value).map((entry) => {
        const item = record(entry);
        const tonNano = item.tonNano;
        const jpegpeNano = item.jpegpeNano;
        for (const amount of [tonNano, jpegpeNano])
          if (
            amount !== null &&
            (typeof amount !== "string" || !/^(0|[1-9]\d{0,79})$/.test(amount))
          )
            throw new Error("unavailable");
        return { tonNano, jpegpeNano };
      }),
    };
  }
}
