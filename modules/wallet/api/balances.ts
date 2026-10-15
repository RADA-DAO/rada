import { Address } from "@ton/ton";
export const JPEGPE_JETTON_MASTER =
  "0:26614d6c77420a6df5bc24e329a70686b20befc5d4ce228e93bd4cb5209679b1";
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.length;
      if (size > 1_000_000) {
        await reader.cancel();
        return null;
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
type Amount = { raw: string; decimals: number; formatted: string };
type Sample = { value: Amount; at: number };
type Entry = {
  gram?: Sample;
  jpegpe?: Sample;
  next: number;
  pending?: Promise<Balances>;
};
export type Balances = {
  gram: Amount | null;
  jpegpe: Amount | null;
  balancesUpdatedAt: string | null;
};
function amount(raw: unknown): Amount | null {
  const value =
    typeof raw === "string"
      ? raw
      : Number.isSafeInteger(raw) && Number(raw) >= 0
        ? String(raw)
        : "";
  if (!/^\d{1,80}$/.test(value)) return null;
  const padded = value.padStart(10, "0"),
    fraction = padded.slice(-9).replace(/0+$/, "");
  return {
    raw: value,
    decimals: 9,
    formatted: padded.slice(0, -9) + (fraction ? "." + fraction : ""),
  };
}
function sameAddress(a: unknown, b: string) {
  try {
    return typeof a === "string" && Address.parse(a).equals(Address.parse(b));
  } catch {
    return false;
  }
}
/** Chain-only cache; the verified viewer→wallet link is still read on every request. */
export function createWalletBalanceReader(
  send: typeof fetch = fetch,
  clock = Date.now,
  toncenterKey = "",
  backupTimeoutMs = 4000,
) {
  const entries = new Map<string, Entry>();
  async function json(url: string, backup = false) {
    try {
      const response = await send(url, {
        headers: {
          Accept: "application/json",
          ...(backup && toncenterKey ? { "X-API-Key": toncenterKey } : {}),
        },
        signal: AbortSignal.timeout(backup ? backupTimeoutMs : 2500),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) return null;
      const value: unknown = await boundedJson(response);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  async function gram(address: string) {
    const primary = amount(
      (
        await json(
          "https://tonapi.io/v2/accounts/" + encodeURIComponent(address),
        )
      )?.balance,
    );
    if (primary) return primary;
    const backup = await json(
      "https://toncenter.com/api/v3/addressInformation?" +
        new URLSearchParams({ address, use_v2: "false" }),
      true,
    );
    return amount(backup?.balance);
  }
  async function jpegpe(address: string) {
    const primary = await json(
      "https://tonapi.io/v2/accounts/" +
        encodeURIComponent(address) +
        "/jettons",
    );
    if (Array.isArray(primary?.balances)) {
      const item = primary.balances.find((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return false;
        const jetton = (value as { jetton?: unknown }).jetton;
        return (
          jetton &&
          typeof jetton === "object" &&
          !Array.isArray(jetton) &&
          sameAddress(
            (jetton as { address?: unknown }).address,
            JPEGPE_JETTON_MASTER,
          )
        );
      }) as { balance?: unknown; jetton?: { decimals?: unknown } } | undefined;
      if (!item) return amount("0");
      if (item.jetton?.decimals === 9 && amount(item.balance))
        return amount(item.balance);
    }
    const backup = await json(
      "https://toncenter.com/api/v3/jetton/wallets?" +
        new URLSearchParams({
          owner_address: address,
          jetton_address: JPEGPE_JETTON_MASTER,
          exclude_zero_balance: "false",
          limit: "2",
        }),
      true,
    );
    if (!Array.isArray(backup?.jetton_wallets)) return null;
    if (!backup.jetton_wallets.length) return amount("0");
    if (backup.jetton_wallets.length !== 1) return null;
    const row = backup.jetton_wallets[0];
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const wallet = row as {
      owner?: unknown;
      jetton?: unknown;
      balance?: unknown;
    };
    return sameAddress(wallet.owner, address) &&
      sameAddress(wallet.jetton, JPEGPE_JETTON_MASTER)
      ? amount(wallet.balance)
      : null;
  }
  function project(entry: Entry): Balances {
    const now = clock(),
      g = entry.gram && now - entry.gram.at <= 120000 ? entry.gram : null,
      j = entry.jpegpe && now - entry.jpegpe.at <= 120000 ? entry.jpegpe : null;
    const observedAt = g && j ? Math.min(g.at, j.at) : (g?.at ?? j?.at);
    return {
      gram: g?.value ?? null,
      jpegpe: j?.value ?? null,
      balancesUpdatedAt:
        observedAt === undefined ? null : new Date(observedAt).toISOString(),
    };
  }
  return function read(address: string, network = "-239"): Promise<Balances> {
    if (network !== "-239") return Promise.reject(new Error("wrong_network"));
    address = Address.parse(address).toRawString();
    const now = clock();
    let entry = entries.get(address);
    if (entry?.pending) return entry.pending;
    if (entry && now < entry.next) return Promise.resolve(project(entry));
    if (!entry) {
      while (entries.size >= 256) entries.delete(entries.keys().next().value!);
      entry = { next: 0 };
      entries.set(address, entry);
    }
    const current = entry;
    current.pending = (async () => {
      try {
        const [g, j] = await Promise.all([gram(address), jpegpe(address)]),
          at = clock();
        if (g) current.gram = { value: g, at };
        if (j) current.jpegpe = { value: j, at };
        current.next = at + (g && j ? 30000 : 15000);
        return project(current);
      } finally {
        delete current.pending;
      }
    })();
    return current.pending;
  };
}
