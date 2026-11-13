import type {
  Appeal,
  Changes,
  CommandResult,
  Mission,
  Page,
  ReputationItem,
  Summary,
} from "../contract.ts";

export class ReputationError extends Error {
  readonly status: number;
  constructor(status = 0) {
    super(`reputation_${String(status)}`);
    this.status = status;
  }
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ReputationError();
  return value as Record<string, unknown>;
};
const string = (v: unknown): v is string => typeof v === "string";
const nullable = (v: unknown) => v === null || string(v);
const point = (v: unknown) =>
  string(v) && /^-?(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(v);
const revision = (v: unknown) => string(v) && /^(?:0|[1-9]\d*)$/.test(v);
const date = (v: unknown) => string(v) && Number.isFinite(Date.parse(v));
const category = (v: unknown) =>
  ["work", "content", "help", "participation"].includes(String(v));
function checked(value: unknown, valid: boolean) {
  if (!valid) throw new ReputationError();
  return value;
}
export function summary(value: unknown): Summary {
  const v = object(value);
  return checked(
    value,
    v.version === 1 &&
      revision(v.revision) &&
      ["today", "week", "previous_week", "all"].includes(String(v.period)) &&
      (v.start === null || date(v.start)) &&
      date(v.end) &&
      point(v.totalPoints) &&
      point(v.lifetimePoints) &&
      Number.isSafeInteger(v.pendingCount) &&
      Number(v.pendingCount) >= 0 &&
      date(v.updatedAt) &&
      Array.isArray(v.categories) &&
      v.categories.every((entry) => {
        const c = object(entry);
        return category(c.category) && point(c.points);
      }),
  ) as Summary;
}
export function item(value: unknown): ReputationItem {
  const v = object(value);
  return checked(
    value,
    string(v.id) &&
      !!v.id &&
      string(v.title) &&
      category(v.category) &&
      point(v.points) &&
      ["accepted", "pending", "excluded", "superseded"].includes(
        String(v.status),
      ) &&
      string(v.reason) &&
      date(v.occurredAt) &&
      date(v.recordedAt) &&
      nullable(v.ruleHash) &&
      nullable(v.missionId) &&
      Array.isArray(v.evidence) &&
      v.evidence.every((entry) => {
        const e = object(entry);
        return string(e.id) && nullable(e.url) && string(e.label);
      }),
  ) as ReputationItem;
}
export function mission(value: unknown): Mission {
  const v = object(value);
  return checked(
    value,
    string(v.id) &&
      !!v.id &&
      Number.isSafeInteger(v.version) &&
      Number(v.version) > 0 &&
      string(v.title) &&
      string(v.description) &&
      category(v.category) &&
      point(v.points) &&
      string(v.ruleHash) &&
      ["acknowledgement", "external"].includes(String(v.verifier)) &&
      ["available", "checking", "completed"].includes(String(v.status)) &&
      nullable(v.actionUrl),
  ) as Mission;
}
export function appeal(value: unknown): Appeal {
  const v = object(value);
  return checked(
    value,
    string(v.id) &&
      string(v.itemId) &&
      string(v.message) &&
      ["open", "resolved"].includes(String(v.status)) &&
      nullable(v.resolution) &&
      date(v.createdAt),
  ) as Appeal;
}
export function page<T>(value: unknown, parse: (v: unknown) => T): Page<T> {
  const v = object(value);
  if (!Array.isArray(v.items) || !nullable(v.nextCursor))
    throw new ReputationError();
  return {
    items: v.items.map(parse),
    nextCursor: v.nextCursor,
  };
}
export function command(value: unknown): CommandResult {
  const v = object(value);
  if (
    v.version !== 1 ||
    !string(v.requestId) ||
    !["completed", "checking"].includes(String(v.state))
  )
    throw new ReputationError();
  return {
    version: 1,
    requestId: v.requestId,
    state: v.state as CommandResult["state"],
    item: item(v.item),
    summary: summary(v.summary),
  };
}
export function changes(value: unknown): Changes {
  const v = object(value);
  return checked(
    value,
    v.version === 1 &&
      revision(v.nextCursor) &&
      typeof v.hasMore === "boolean" &&
      typeof v.resetRequired === "boolean" &&
      Array.isArray(v.changes) &&
      v.changes.every((entry) => {
        const c = object(entry);
        return (
          revision(c.revision) &&
          ["item", "appeal"].includes(String(c.type)) &&
          string(c.itemId) &&
          date(c.recordedAt)
        );
      }),
  ) as Changes;
}
export function envelope(value: unknown, key: string): unknown {
  return object(value)[key];
}
/** A receipt advances the floor; older reads cannot erase a confirmed result. */
export class ReadGuard {
  private generation = 0;
  private floor = 0n;
  begin() {
    return ++this.generation;
  }
  invalidate() {
    this.generation++;
  }
  receipt(value: Summary) {
    this.invalidate();
    this.floor =
      this.floor > BigInt(value.revision) ? this.floor : BigInt(value.revision);
  }
  accept(ticket: number, value: Summary) {
    return ticket === this.generation && BigInt(value.revision) >= this.floor;
  }
}

export function receiptIsCurrent(
  value: Summary,
  current?: Summary,
  now = Date.now(),
) {
  const day = (instant: string | number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(
      new Date(instant),
    );
  return (
    value.period === "today" &&
    value.start !== null &&
    day(value.start) === day(now) &&
    day(value.end) === day(now) &&
    (!current ||
      (value.period === current.period && value.start === current.start))
  );
}
