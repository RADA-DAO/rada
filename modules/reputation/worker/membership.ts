import { createHash } from "node:crypto";
import { exactObject } from "./policy.ts";
export type MembershipConfig = Readonly<{
  missionId: string;
  channelId: string;
  proofUrl: string;
}>;
export type MembershipInput = Readonly<{
  missionId: string;
  subjectId: string;
  telegramUserId: string;
}>;
export type TelegramReadMethod = "getMe" | "getChat" | "getChatMember";
export type TelegramReadClient = (
  method: TelegramReadMethod,
  parameters: Readonly<Record<string, string | number>>,
  signal: AbortSignal,
) => Promise<unknown>;
export type MembershipResult =
  | {
      state: "verified";
      subjectId: string;
      missionId: string;
      channelId: string;
      proofUrl: string;
      semanticKey: string;
    }
  | {
      state: "checking";
      reason:
        | "unconfigured"
        | "invalid_input"
        | "authority_unavailable"
        | "membership_absent"
        | "unavailable";
    };
const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function member(
  value: unknown,
  userId: number,
): value is Record<string, unknown> {
  return (
    record(value) &&
    record(value.user) &&
    value.user.id === userId &&
    typeof value.status === "string"
  );
}
/** No subscriptions are configured by default. This never awards, revokes or sends messages. */
export function membershipVerifier(
  config: MembershipConfig | null,
  client: TelegramReadClient,
) {
  if (config !== null) {
    if (
      !exactObject(config, ["missionId", "channelId", "proofUrl"]) ||
      typeof config.missionId !== "string" ||
      !config.missionId ||
      typeof config.channelId !== "string" ||
      !/^-100\d{1,13}$/.test(config.channelId) ||
      !Number.isSafeInteger(Number(config.channelId))
    )
      throw new Error("invalid_membership_config");
    const proof = new URL(config.proofUrl);
    if (
      proof.protocol !== "https:" ||
      proof.hostname !== "t.me" ||
      proof.username ||
      proof.password
    )
      throw new Error("invalid_membership_proof");
    config = Object.freeze({ ...config });
  }
  return async (
    input: MembershipInput,
    signal: AbortSignal,
  ): Promise<MembershipResult> => {
    if (!config) return { state: "checking", reason: "unconfigured" };
    if (
      !exactObject(input, ["missionId", "subjectId", "telegramUserId"]) ||
      input.missionId !== config.missionId ||
      typeof input.subjectId !== "string" ||
      !input.subjectId ||
      typeof input.telegramUserId !== "string" ||
      !/^[1-9]\d{0,15}$/.test(input.telegramUserId) ||
      !id(Number(input.telegramUserId))
    )
      return { state: "checking", reason: "invalid_input" };
    const frozen = Object.freeze({ ...input });
    const channelId = config.channelId;
    try {
      if (signal.aborted) return { state: "checking", reason: "unavailable" };
      const me = await client("getMe", {}, signal);
      if (!record(me) || me.is_bot !== true || !id(me.id))
        return { state: "checking", reason: "authority_unavailable" };
      const chat = await client("getChat", { chat_id: channelId }, signal);
      if (
        !record(chat) ||
        String(chat.id) !== channelId ||
        chat.type !== "channel"
      )
        return { state: "checking", reason: "authority_unavailable" };
      const authority = await client(
        "getChatMember",
        { chat_id: channelId, user_id: me.id },
        signal,
      );
      if (
        !member(authority, me.id) ||
        !["administrator", "creator"].includes(String(authority.status))
      )
        return { state: "checking", reason: "authority_unavailable" };
      const targetId = Number(frozen.telegramUserId);
      const target = await client(
        "getChatMember",
        { chat_id: channelId, user_id: targetId },
        signal,
      );
      signal.throwIfAborted();
      if (!member(target, targetId))
        return { state: "checking", reason: "unavailable" };
      if (["left", "kicked"].includes(String(target.status)))
        return { state: "checking", reason: "membership_absent" };
      if (
        !["member", "administrator", "creator"].includes(String(target.status))
      )
        return { state: "checking", reason: "unavailable" };
      return {
        state: "verified",
        subjectId: frozen.subjectId,
        missionId: config.missionId,
        channelId,
        proofUrl: config.proofUrl,
        semanticKey: createHash("sha256")
          .update(
            JSON.stringify([
              frozen.subjectId,
              "telegram_membership",
              config.missionId,
            ]),
          )
          .digest("hex"),
      };
    } catch {
      return { state: "checking", reason: "unavailable" };
    }
  };
}
/** Fixed HTTPS endpoint and read-method allowlist; credential stays inside this closure. */
export function telegramReadClient(
  credential: () => string,
  fetcher: typeof fetch = fetch,
): TelegramReadClient {
  return async (method, parameters, signal) => {
    if (!["getMe", "getChat", "getChatMember"].includes(method))
      throw new Error("unsupported_telegram_method");
    const token = credential();
    if (!/^[0-9]+:[A-Za-z0-9_-]{1,256}$/.test(token))
      throw new Error("invalid_telegram_credential");
    const response = await fetcher(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parameters),
        signal,
      },
    );
    if (!response.ok) throw new Error("telegram_unavailable");
    const body = response.body;
    if (!body) throw new Error("invalid_telegram_response");
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 65536) {
          await reader.cancel();
          throw new Error("telegram_response_limit");
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !record(payload) ||
      payload.ok !== true ||
      !Object.hasOwn(payload, "result")
    )
      throw new Error("telegram_unavailable");
    return payload.result;
  };
}
