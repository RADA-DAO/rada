import type { Action } from "./store.ts";
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
const text = (v: unknown, max: number) =>
  typeof v === "string" &&
  v.trim().length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f\x7f]/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
export function validRules(v: unknown): boolean {
  if (!object(v) || Object.keys(v).length !== 7) return false;
  return (
    ["steward-opens", "author-opens"].includes(String(v.who_opens)) &&
    typeof v.duration_hours === "number" &&
    Number.isFinite(v.duration_hours) &&
    v.duration_hours >= 1 &&
    v.duration_hours <= 720 &&
    typeof v.decision_days === "number" &&
    Number.isFinite(v.decision_days) &&
    v.decision_days >= 1 &&
    v.decision_days <= 365 &&
    [
      "allow_vote_changes",
      "require_membership_at_open",
      "keep_departed_votes",
      "allow_majority_override",
    ].every((k) => typeof v[k] === "boolean")
  );
}
export function parseInput(
  action: Action,
  value: unknown,
): Record<string, unknown> | null {
  if (!object(value)) return null;
  const allowed: Record<Action, string[]> = {
    create: ["title", "body"],
    open: [],
    withdraw: ["reason"],
    vote: ["choice"],
    decide: ["outcome", "reason"],
    evidence: ["body", "tx_hash", "link"],
    settings: ["rules", "reason"],
  };
  if (Object.keys(value).some((k) => !allowed[action].includes(k))) return null;
  // Plain validated text. Preserve paragraph breaks as spaces; never interpret HTML.
  const result = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      typeof v === "string" && ["title", "body", "reason"].includes(k)
        ? v.replace(/\r?\n/g, " ").trim()
        : v,
    ]),
  );
  switch (action) {
    case "create":
      return text(result.title, 200) && text(result.body, 20000)
        ? result
        : null;
    case "open":
      return result;
    case "withdraw":
      return text(result.reason, 2000) ? result : null;
    case "vote":
      return result.choice === null ||
        ["for", "against", "abstain"].includes(String(result.choice))
        ? result
        : null;
    case "decide":
      return ["accept", "reject", "defer"].includes(String(result.outcome)) &&
        text(result.reason, 4000)
        ? result
        : null;
    case "settings":
      return validRules(result.rules) && text(result.reason, 2000)
        ? result
        : null;
    case "evidence": {
      if (!text(result.body, 4000)) return null;
      if (
        result.tx_hash !== undefined &&
        (typeof result.tx_hash !== "string" ||
          !/^[a-f0-9]{64}$/i.test(result.tx_hash))
      )
        return null;
      if (result.link !== undefined) {
        if (typeof result.link !== "string" || result.link.length > 2048)
          return null;
        try {
          const url = new URL(result.link);
          if (
            url.protocol !== "https:" ||
            !url.hostname ||
            url.username ||
            url.password
          )
            return null;
        } catch {
          return null;
        }
      }
      return result;
    }
  }
}
