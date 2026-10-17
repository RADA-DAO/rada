import assert from "node:assert/strict";
import { test } from "node:test";
import { fake } from "./fake-dom.ts";
import { EvidenceLink, Tally } from "../src/index.ts";
await test("tallies expose counts and normalize invalid counts without NaN bars", () => {
  const root = fake(
    Tally({
      label: "Advisory tally",
      items: [
        { label: "For", count: 3 },
        { label: "Against", count: 1 },
        { label: "Abstain", count: NaN },
        { label: "Invalid", count: -5 },
      ],
    }),
  );
  assert.equal(root.getAttribute("role"), "group");
  assert.equal(root.getAttribute("aria-label"), "Advisory tally");
  assert.equal(root.child(0).child(2).getAttribute("aria-valuetext"), "3");
  const bar = root.child(0).child(2) as unknown as HTMLProgressElement;
  assert.equal(bar.value, 3);
  assert.equal(bar.max, 4);
  assert.equal(root.child(2).child(2).getAttribute("aria-valuetext"), "0");
  assert.equal(root.child(3).child(2).getAttribute("aria-valuetext"), "0");
  const empty = fake(
    Tally({ label: "Empty", items: [{ label: "For", count: 0 }] }),
  );
  assert.equal(empty.child(0).child(2).getAttribute("aria-valuetext"), "0");
});
await test("evidence links reject unsafe protocols and embedded credentials", () => {
  for (const href of [
    "javascript:alert(1)",
    "http://example.com",
    "https://user:pass@example.com",
    "invalid",
  ]) {
    assert.equal(
      (EvidenceLink({ label: "Evidence", href }) as HTMLAnchorElement).href,
      undefined,
    );
  }
  const safe = EvidenceLink({
    label: "Evidence",
    href: "https://example.com/proof",
  }) as HTMLAnchorElement;
  assert.equal(safe.href, "https://example.com/proof");
  assert.equal(safe.rel, "noopener noreferrer");
});
