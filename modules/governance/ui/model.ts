export type Choice = "for" | "against" | "abstain";
export const choices: Choice[] = ["for", "against", "abstain"];
export type Rules = {
  who_opens: "steward-opens" | "author-opens";
  duration_hours: number;
  decision_days: number;
  allow_vote_changes: boolean;
  require_membership_at_open: boolean;
  keep_departed_votes: boolean;
  allow_majority_override: boolean;
};
export type Proposal = {
  proposal_id: string;
  title: string;
  body: string;
  state: "created" | "opened" | "closed" | "withdrawn";
  closes_at: string | null;
  rules: Rules | null;
  tally: Record<Choice, number>;
  decision_status: string;
  decision: { outcome: "accept" | "reject" | "defer"; reason: string } | null;
  evidence: { body: string; tx_hash: string | null; link: string | null }[];
  withdrawal_reason: string | null;
};
export type Vote = {
  vote_id: string;
  receipt: string;
  choice: Choice | null;
  voter: { username: string } | null;
  current: boolean;
  excluded: boolean;
};
export type Mine = {
  proposal_id: string;
  choice: Choice | null;
  receipt: string;
};
export type Settings = { version: number; rules: Rules };
export type History = Settings & { reason: string; changed_at: string };
export type Tab = "open" | "closed" | "decided";
export function inTab(p: Proposal, tab: Tab): boolean {
  if (tab === "decided") return p.decision !== null;
  if (tab === "closed")
    return !p.decision && ["closed", "withdrawn"].includes(p.state);
  return !p.decision && ["created", "opened"].includes(p.state);
}
export function status(p: Proposal, now = Date.now()): string {
  if (p.decision) return p.decision.outcome;
  if (p.state === "opened")
    return Date.parse(p.closes_at ?? "") > now ? "voting" : "tally";
  if (p.state === "closed")
    return p.decision_status === "decision_pending"
      ? "decision_pending"
      : "tally";
  return p.state;
}
export function canVote(p: Proposal, member: boolean, mine?: Mine): boolean {
  return (
    member &&
    p.state === "opened" &&
    Date.parse(p.closes_at ?? "") > Date.now() &&
    (!mine || p.rules?.allow_vote_changes === true)
  );
}
