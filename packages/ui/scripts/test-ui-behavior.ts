import assert from "node:assert/strict";
import { Button, Card, EmptyState, ErrorState, Sheet } from "../src/index.ts";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, EventListener>();
  className = "";
  textContent = "";
  type = "";
  id = "";
  disabled = false;
  closed = false;
  append(...nodes: Node[]): void {
    this.children.push(...(nodes as unknown as FakeElement[]));
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, listener);
  }
  close(): void {
    this.closed = true;
  }
  click(): void {
    this.listeners.get("click")?.(new Event("click"));
  }
}

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    createElement: () => new FakeElement() as unknown as HTMLElement,
  },
});

let clicks = 0;
const button = Button("Open", {
  onClick: () => clicks++,
}) as unknown as FakeElement;
button.click();
assert.equal(button.className, "rada-button");
assert.equal(button.textContent, "Open");
assert.equal(clicks, 1);

const child = new FakeElement() as unknown as Node;
const card = Card({
  label: "Summary",
  children: [child],
}) as unknown as FakeElement;
assert.equal(card.attributes.get("aria-label"), "Summary");
assert.equal(card.children[0], child);

const sheet = Sheet({
  title: "Details",
  closeLabel: "Close",
}) as unknown as FakeElement;
assert.equal(sheet.attributes.get("aria-labelledby"), sheet.children[0]?.id);
assert.ok(sheet.children[1]);
sheet.children[1].click();
assert.equal(sheet.closed, true);

const empty = EmptyState({ message: "No entries" }) as unknown as FakeElement;
assert.equal(empty.attributes.get("role"), "status");
assert.equal(empty.children[0]?.textContent, "No entries");

let retries = 0;
const error = ErrorState({
  message: "Unavailable",
  retryLabel: "Retry",
  onRetry: () => retries++,
}) as unknown as FakeElement;
assert.equal(error.attributes.get("role"), "alert");
assert.ok(error.children[1]);
error.children[1].click();
assert.equal(retries, 1);
