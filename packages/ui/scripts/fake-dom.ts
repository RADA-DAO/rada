/** Minimal DOM double so component tests run in plain Node, without a browser or new dependency. */
type Listener = (event: { type: string; target?: FakeElement }) => void;

export class FakeElement {
  readonly tagName: string;
  children: FakeElement[] = [];
  parent: FakeElement | undefined;
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string | undefined> = {};
  readonly listeners = new Map<string, { run: Listener; once: boolean }[]>();
  className = "";
  id = "";
  type = "";
  value = "";
  title = "";
  name = "";
  src = "";
  alt = "";
  maxLength = -1;
  rows = 0;
  required = false;
  hidden = false;
  disabled = false;
  open = false;
  private ownText = "";

  constructor(tagName: string) {
    this.tagName = tagName;
  }
  get textContent(): string {
    return (
      this.ownText + this.children.map((child) => child.textContent).join("")
    );
  }
  set textContent(value: string) {
    this.ownText = value;
    for (const child of this.children) child.parent = undefined;
    this.children = [];
  }
  get classNames(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  get classList() {
    return {
      contains: (name: string) => this.classNames.includes(name),
      add: (name: string) => {
        if (!this.classNames.includes(name))
          this.className = [...this.classNames, name].join(" ");
      },
    };
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        this.ownText += node;
        continue;
      }
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]): void {
    this.textContent = "";
    this.append(...nodes);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = undefined;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  addEventListener(
    name: string,
    run: Listener,
    options?: { once?: boolean },
  ): void {
    const list = this.listeners.get(name) ?? [];
    list.push({ run, once: options?.once ?? false });
    this.listeners.set(name, list);
  }
  dispatch(name: string): void {
    for (const entry of [...(this.listeners.get(name) ?? [])]) {
      if (entry.once)
        this.listeners.set(
          name,
          (this.listeners.get(name) ?? []).filter((e) => e !== entry),
        );
      entry.run({ type: name });
    }
  }
  click(): void {
    if (!this.disabled) this.dispatch("click");
  }
  contains(node: FakeElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }
  get isConnected(): boolean {
    return this === fakeDocument.body || (this.parent?.isConnected ?? false);
  }
  private withinInert(): boolean {
    return (
      this.attributes.has("inert") || (this.parent?.withinInert() ?? false)
    );
  }
  matches(selector: string): boolean {
    if (
      selector === "h1:not([inert] *)" ||
      selector === "main h1:not([inert] *)"
    ) {
      return this.tagName === "h1" && !this.withinInert();
    }
    if (selector === ":disabled") return this.disabled;
    if (selector === "[data-focus-key]") return !!this.dataset.focusKey;
    if (selector === "dialog[open]")
      return this.tagName === "dialog" && this.open;
    return this.tagName === selector.split(" ").at(-1);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  closest(selector: string): FakeElement | null {
    return this.matches(selector)
      ? this
      : (this.parent?.closest(selector) ?? null);
  }
  focus(): void {
    fakeDocument.activeElement = this;
    this.notifyFocus(this);
  }
  private notifyFocus(target: FakeElement): void {
    for (const listener of this.listeners.get("focusin") ?? [])
      listener.run({ type: "focusin", target });
    this.parent?.notifyFocus(target);
  }
  showModal(): void {
    this.open = true;
  }
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.dispatch("close");
  }
  reportValidity(): boolean {
    return true;
  }
  child(index: number): FakeElement {
    const found = this.children[index];
    if (!found)
      throw new Error(`no child ${String(index)} in <${this.tagName}>`);
    return found;
  }
  /** Depth-first search by class name. */
  all(className: string): FakeElement[] {
    return this.children.flatMap((child) => [
      ...(child.classNames.includes(className) ? [child] : []),
      ...child.all(className),
    ]);
  }
}

export const fakeDocument = {
  body: new FakeElement("body"),
  activeElement: undefined as FakeElement | undefined,
  createElement: (tag: string) => new FakeElement(tag),
  querySelector: (selector: string): FakeElement | null =>
    fakeDocument.body.querySelector(selector),
  querySelectorAll: (selector: string): FakeElement[] =>
    fakeDocument.body.querySelectorAll(selector),
};

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: fakeDocument,
});

export const fake = (node: unknown): FakeElement => node as FakeElement;

export const mutations: (() => void)[] = [];
Object.defineProperty(globalThis, "HTMLElement", {
  configurable: true,
  value: FakeElement,
});
Object.defineProperty(globalThis, "MutationObserver", {
  configurable: true,
  value: class {
    constructor(callback: () => void) {
      mutations.push(callback);
    }
    disconnect() {
      /* Tests flush mutations explicitly. */
    }
    observe() {
      /* Tests flush mutations explicitly. */
    }
  },
});
