import type { Page, ReputationItem, Summary } from "../contract.ts";
import { locales, type ReputationLocale } from "./locales.ts";

/** Pure HTML presentation. The caller fetches both projections for the same actor/period. */
export function renderMe(
  summary: Summary,
  page: Page<ReputationItem>,
  locale: ReputationLocale = "uk",
): string {
  const t = locales[locale];
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char] ?? char,
    );
  const clip = (text: string, limit: number) =>
    Array.from(text).slice(0, limit).join("");
  const date = (instant: string) =>
    new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", {
      timeZone: "Europe/Kyiv",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(instant));
  const lines = [
    `<b>${t.title}</b>`,
    `${t.period}: ${t.periods[summary.period]}`,
    `${t.window}: ${summary.start ? date(summary.start) : t.since} → ${date(summary.end)} (${t.zone})`,
    `${t.total}: <b>${escape(summary.totalPoints)}</b>`,
    `${t.lifetime}: ${escape(summary.lifetimePoints)}`,
    `${t.pending}: ${String(summary.pendingCount)}`,
    `${t.freshness}: ${date(summary.updatedAt)} (${t.zone})`,
    "",
    t.recent,
  ];
  const visible = page.items.slice(0, 3);
  if (visible.length === 0) lines.push(t.empty);
  for (const item of visible) {
    lines.push(
      `• ${escape(clip(item.title, 60))} · ${escape(item.points)} · ${t.statuses[item.status]}`,
    );
    if (item.reason) lines.push(escape(clip(item.reason, 80)));
  }
  if (page.nextCursor || page.items.length > visible.length) lines.push(t.more);
  return lines.join("\n");
}
