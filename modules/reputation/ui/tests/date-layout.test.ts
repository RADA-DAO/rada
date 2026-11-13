import assert from "node:assert/strict";
import { test } from "node:test";
import "../../../../packages/ui/scripts/fake-dom.ts";
import { Button, Group } from "../../../../packages/ui/src/index.ts";
import type { Mission } from "../../contract.ts";
import { dateTime, taskView } from "../views.ts";
const synthetic: Mission = {
  id: "synthetic-task",
  title: "Synthetic task",
  description: "Synthetic result",
  version: 1,
  category: "help",
  points: "2.5",
  ruleHash: "synthetic",
  verifier: "external",
  status: "available",
  actionUrl: null,
};
await test("task points distinguish future confirmation from earned REP in every state", () => {
  const text = (key: string, values?: Record<string, string | number>) =>
    `${key}:${String(values?.points ?? "")}`;
  for (const status of ["available", "checking", "completed"] as const) {
    const view = Group(
      taskView(
        { text, locale: "uk", points: (points) => `${points} REP` },
        [{ ...synthetic, status }],
        Button(text("report.open")),
        { busy: new Set(), retry: () => false, verify() {} },
      ),
    );
    assert.ok(
      view.textContent.includes(
        `${status === "completed" ? "award.earned" : "award.future"}:2.5 REP`,
      ),
    );
  }
});
await test("short local date omits visible seconds and retains exact UTC metadata", () => {
  const instant = "2026-11-13T12:34:56.789Z";
  for (const locale of ["en", "uk"] as const) {
    const stamp = dateTime(locale, instant);
    assert.equal(stamp.title, instant);
    assert.equal(
      stamp.textContent,
      new Intl.DateTimeFormat(locale, {
        timeZone: "Europe/Kyiv",
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(instant)),
    );
    assert.equal(stamp.textContent.includes(":56"), false);
  }
});
