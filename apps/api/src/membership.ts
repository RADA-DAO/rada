export type MembershipStatus = "member" | "not_member" | "unavailable";
export interface MembershipProvider {
  status(verifiedTelegramId: string): Promise<MembershipStatus>;
}
export const unavailableMembership: MembershipProvider = {
  status: () => Promise.resolve("unavailable"),
};
export const MEMBERSHIP_CACHE_TTL_MS = 30_000;
export const MEMBERSHIP_CACHE_MAX_SIZE = 1_024;
const REQUEST_TIMEOUT_MS = 2_000;

type Dependencies = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

// Each instance owns one bot/chat and its own bounded cache; never share across audiences.
export class TelegramMembershipProvider implements MembershipProvider {
  private readonly cache = new Map<
    string,
    { status: MembershipStatus; expires: number }
  >();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    dependencies: Dependencies = {},
  ) {
    this.request = dependencies.fetch ?? fetch;
    this.now = dependencies.now ?? Date.now;
    this.timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!token || !/^-[1-9][0-9]*$/.test(chatId))
      throw new Error("Invalid membership configuration");
  }

  async status(verifiedTelegramId: string): Promise<MembershipStatus> {
    if (
      !/^[1-9][0-9]*$/.test(verifiedTelegramId) ||
      !Number.isSafeInteger(Number(verifiedTelegramId))
    )
      return "unavailable";
    const cached = this.cache.get(verifiedTelegramId);
    if (cached && cached.expires > this.now()) return cached.status;
    this.cache.delete(verifiedTelegramId);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<MembershipStatus>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve("unavailable");
        }, this.timeoutMs);
      });
      const result = await Promise.race([
        this.lookup(verifiedTelegramId, controller.signal),
        timeout,
      ]);
      if (result !== "unavailable") {
        const now = this.now();
        for (const [id, entry] of this.cache)
          if (entry.expires <= now) this.cache.delete(id);
        if (this.cache.size >= MEMBERSHIP_CACHE_MAX_SIZE)
          this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(verifiedTelegramId, {
          status: result,
          expires: now + MEMBERSHIP_CACHE_TTL_MS,
        });
      }
      return result;
    } catch {
      // Fetch errors may contain the token URL; never log or propagate them.
      return "unavailable";
    } finally {
      clearTimeout(timer);
    }
  }

  private async lookup(
    id: string,
    signal: AbortSignal,
  ): Promise<MembershipStatus> {
    const response = await this.request(
      `https://api.telegram.org/bot${this.token}/getChatMember`,
      {
        method: "POST",
        redirect: "error",
        signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, user_id: Number(id) }),
      },
    );
    if (!response.ok) return "unavailable";
    const data = await response.json();
    if (
      data?.ok !== true ||
      !data.result ||
      String(data.result.user?.id) !== id ||
      typeof data.result.user?.id !== "number"
    )
      return "unavailable";
    switch (data.result.status) {
      case "creator":
      case "administrator":
      case "member":
        return "member";
      case "left":
      case "kicked":
        return "not_member";
      case "restricted":
        return typeof data.result.is_member === "boolean"
          ? data.result.is_member
            ? "member"
            : "not_member"
          : "unavailable";
      default:
        return "unavailable";
    }
  }
}
