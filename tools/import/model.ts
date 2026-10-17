import { createHash } from "node:crypto";
export interface Person {
  id: string;
  telegram_id: string | null;
  created_at: string;
}
export interface Event {
  from: string | null;
  to: string;
  at: string;
  key: string;
  imported: boolean;
}
export interface Frog {
  display_name: string | null;
  id: string;
  username: string;
  creator: string;
  owner: string;
  background_color: string | null;
  accent_color: string | null;
  background_proof: unknown;
  accent_proof: unknown;
  created_at: string;
  events: Event[];
}
export interface Selection {
  id: string;
  frog: string;
}
export interface RecordPlan {
  entity: string;
  key: string;
  id: string;
  value: Person | Frog | Selection;
}
export interface Conflict {
  entity: string;
  key: string;
  reason: string;
}
export interface Snapshot {
  records: RecordPlan[];
  conflicts: Conflict[];
  skipped: { category: string; count: number }[];
  counts: Record<string, number>;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
// Preserve legacy UUIDs, but only after recording the bijection in ops.
export const tables = {
  people: "public.ecosystem_users",
  frogs: "public.jpegpe_frog_submissions",
  selections: "public.jpegpe_profile_appearances",
} as const;
export function table(entity: string): string {
  const result = (tables as Record<string, string | undefined>)[entity];
  if (!result) throw new Error("Invalid import entity");
  return result;
}
