import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMe } from "../bot/me.ts";
import { locales } from "../bot/locales/index.ts";
import type { ReputationItem, Summary } from "../contract.ts";
const summary: Summary = {
  version: 1,
  revision: "7",
  period: "today",
  start: "2026-10-25T00:00:00Z",
  end: "2026-10-25T22:00:00Z",
  totalPoints: "0",
  lifetimePoints: "12.3456",
  pendingCount: 2,
  categories: [],
  updatedAt: "2026-10-25T02:30:00Z",
};
const item: ReputationItem = {
  id: "one",
  title: '<a href="https://evil.test">&',
  category: "help",
  points: "0",
  status: "pending",
  reason: "<script>bad()</script>",
  occurredAt: summary.end,
  recordedAt: summary.end,
  ruleHash: null,
  evidence: [{ id: "e", url: "javascript:alert(1)", label: "unsafe" }],
  missionId: null,
};
void test("/me renders supplied exact totals, processing, bounds and freshness in both languages", () => {
  const en = renderMe(summary, { items: [], nextCursor: null }, "en");
  assert.match(en, /Points: <b>0<\/b>/);
  assert.match(en, /All-time points: 12\.3456/);
  assert.match(en, /Awaiting processing: 2/);
  assert.match(en, /Period bounds: .*Europe\/Kyiv/);
  assert.match(en, /Updated: 25\/10\/2026, 04:30/);
  assert.ok(
    renderMe(summary, { items: [], nextCursor: null }).includes(
      `${locales.uk.pending}: 2`,
    ),
  );
});
void test("/me escapes untrusted result text and limits supplied items without scoring", () => {
  const html = renderMe(
    summary,
    { items: Array.from({ length: 10 }, () => item), nextCursor: "next" },
    "en",
  );
  assert.ok(
    !html.includes("<a ") &&
      !html.includes("<script>") &&
      !html.includes("javascript:"),
  );
  assert.match(html, /&lt;a href=&quot;https:\/\/evil.test&quot;&gt;&amp;/);
  assert.equal(html.split("• ").length - 1, 3);
  assert.match(html, /More results/);
  assert.match(html, /Points: <b>0<\/b>/);
  const maximum = renderMe(summary, {
    items: Array.from({ length: 4 }, () => ({
      ...item,
      title: "&".repeat(1000),
      reason: "<".repeat(1000),
    })),
    nextCursor: null,
  });
  assert.ok(maximum.length < 4096);
});
