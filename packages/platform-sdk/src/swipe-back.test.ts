import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";
import * as physics from "./screen-swipe-physics.ts";

// Exercise the actual DOM controller without a browser or its CSS side effect.
const source = readFileSync(new URL("./swipe-back.ts", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?from "\.\/screen-swipe-physics.ts";\n/, "")
  .replace('import "./swipe-back.css";', "")
  .replace(/^export /gm, "");
const controller = ts.transpileModule(
  source + "\nglobalThis.installController = installSwipeBack;",
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

type EventValue = {
  target?: Surface;
  pointerId?: number;
  clientX?: number;
  clientY?: number;
};
class Surface {
  handlers = new Map<string, ((event: unknown) => void)[]>();
  captured = new Set<number>();
  classes = new Set<string>();
  values = new Map<string, string>();
  ignored = false;
  parentElement = null;
  scrollWidth = 0;
  clientWidth = 0;
  style = {
    touchAction: "auto",
    setProperty: (key: string, value: string) => this.values.set(key, value),
    removeProperty: (key: string) => this.values.delete(key),
  };
  classList = {
    contains: (name: string) => this.classes.has(name),
    add: (...names: string[]) => {
      names.forEach((name) => this.classes.add(name));
    },
    remove: (...names: string[]) => {
      names.forEach((name) => this.classes.delete(name));
    },
  };
  ownerDocument: Surface = this;
  addEventListener(name: string, callback: (event: unknown) => void) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]);
  }
  removeEventListener(name: string, callback: (event: unknown) => void) {
    this.handlers.set(
      name,
      (this.handlers.get(name) ?? []).filter((item) => item !== callback),
    );
  }
  closest() {
    return this.ignored ? this : null;
  }
  getSelection() {
    return null;
  }
  getBoundingClientRect() {
    return { width: 320 };
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
  emit(name: string, values: EventValue = {}) {
    let prevented = false;
    const event = {
      target: this,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 4,
      clientY: 100,
      timeStamp: 10,
      preventDefault() {
        prevented = true;
      },
      ...values,
    };
    for (const callback of this.handlers.get(name) ?? []) callback(event);
    return prevented;
  }
}
function fixture(canStart = true) {
  const screen = new Surface();
  const window = new Surface();
  const runtime: {
    installController?: (
      screen: Surface,
      options: unknown,
    ) => {
      active(): boolean;
      dispose(): void;
    };
  } = {};
  new Script(controller).runInNewContext(
    Object.assign(runtime, physics, {
      Element: Surface,
      window,
      performance,
      setTimeout,
      clearTimeout,
      cancelAnimationFrame() {},
    }),
  );
  assert.ok(runtime.installController);
  const instance = runtime.installController(screen, {
    canStart: () => canStart,
    back() {},
  });
  return { screen, instance };
}

void test("bare shell capture precedes the first move into an opaque iframe and releases for vertical intent", () => {
  const { screen, instance } = fixture();
  assert.equal(screen.emit("pointerdown"), false);
  assert.equal(screen.hasPointerCapture(1), true);
  assert.equal(screen.classes.has("rada-back-dragging"), false);
  // First delivered move may already be beyond the 18px shell gutter.
  assert.equal(screen.emit("pointermove", { clientX: 25 }), true);
  assert.equal(screen.classes.has("rada-back-dragging"), true);
  assert.equal(screen.values.get("--back-x"), "21px");
  instance.dispose();
  assert.equal(screen.hasPointerCapture(1), false);
  assert.equal(screen.style.touchAction, "auto");
  const vertical = fixture();
  vertical.screen.emit("pointerdown");
  assert.equal(vertical.screen.emit("pointermove", { clientY: 120 }), false);
  assert.equal(vertical.screen.hasPointerCapture(1), false);
  assert.equal(vertical.instance.active(), false);
  vertical.instance.dispose();
  for (const end of ["pointerup", "pointercancel"]) {
    const pending = fixture();
    pending.screen.emit("pointerdown");
    pending.screen.emit(end);
    assert.equal(pending.screen.hasPointerCapture(1), false);
    assert.equal(pending.instance.active(), false);
    pending.instance.dispose();
  }
});

void test("descendant buttons keep native targeting until horizontal lock; owned controls and denied starts never capture", () => {
  const { screen, instance } = fixture();
  const button = new Surface();
  screen.emit("pointerdown", { target: button });
  assert.equal(screen.hasPointerCapture(1), false);
  assert.equal(
    screen.emit("pointermove", { target: button, clientX: 25 }),
    true,
  );
  assert.equal(screen.hasPointerCapture(1), true);
  instance.dispose();
  for (const allowed of [true, false]) {
    const next = fixture(allowed);
    const input = new Surface();
    input.ignored = true;
    next.screen.emit("pointerdown", { target: allowed ? input : next.screen });
    assert.equal(next.screen.hasPointerCapture(1), false);
    assert.equal(next.instance.active(), false);
    next.instance.dispose();
  }
});
