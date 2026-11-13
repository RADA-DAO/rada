/** Shared wire contract. Scores are exact decimal strings with <=4 places. */
export const REPUTATION_VERSION = 1 as const;
export type Period = "today" | "week" | "previous_week" | "all";
export type ItemStatus = "accepted" | "pending" | "excluded" | "superseded";
export type Category = "work" | "content" | "help" | "participation";
export type Summary = {
  version: 1;
  revision: string;
  period: Period;
  start: string | null;
  end: string;
  totalPoints: string;
  lifetimePoints: string;
  pendingCount: number;
  categories: { category: Category; points: string }[];
  updatedAt: string;
};
export type Mission = {
  id: string;
  version: number;
  title: string;
  description: string;
  category: Category;
  points: string;
  ruleHash: string;
  verifier: "acknowledgement" | "external";
  status: "available" | "checking" | "completed";
  actionUrl: string | null;
};
export type Evidence = { id: string; url: string | null; label: string };
export type ReputationItem = {
  id: string;
  title: string;
  category: Category;
  points: string;
  status: ItemStatus;
  reason: string;
  occurredAt: string;
  recordedAt: string;
  ruleHash: string | null;
  evidence: Evidence[];
  missionId: string | null;
};
export type Page<T> = { items: T[]; nextCursor: string | null };
export type CommandResult = {
  version: 1;
  requestId: string;
  state: "completed" | "checking";
  item: ReputationItem;
  summary: Summary;
};
export type Change = {
  revision: string;
  type: "item" | "appeal";
  itemId: string;
  recordedAt: string;
};
export type Changes = {
  version: 1;
  changes: Change[];
  nextCursor: string;
  hasMore: boolean;
  resetRequired: boolean;
};
export type Appeal = {
  id: string;
  itemId: string;
  message: string;
  status: "open" | "resolved";
  resolution: string | null;
  createdAt: string;
};
export type VerifyInput = { requestId: string; missionVersion: number };
export type ReportInput = {
  requestId: string;
  title: string;
  description: string;
  occurredAt: string;
  evidenceUrl?: string;
};
export type AppealInput = { requestId: string; message: string };

/** All reads are scoped to the authenticated actor; actor is never request JSON. */
export interface ReputationStore {
  summary(actor: string, period: Period): Promise<Summary>;
  missions(actor: string, cursor: string | null): Promise<Page<Mission>>;
  items(actor: string, period: Period, cursor: string | null): Promise<Page<ReputationItem>>;
  item(actor: string, id: string): Promise<ReputationItem | null>;
  verify(actor: string, missionId: string, input: VerifyInput): Promise<CommandResult>;
  report(actor: string, input: ReportInput): Promise<CommandResult>;
  command(actor: string, requestId: string): Promise<CommandResult | null>;
  changes(actor: string, after: string): Promise<Changes>;
  appeal(actor: string, itemId: string, input: AppealInput): Promise<Appeal>;
  appeals(actor: string, itemId: string): Promise<Appeal[]>;
}
