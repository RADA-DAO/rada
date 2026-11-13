import test from "node:test";
import { Script } from "node:vm";
import assert from "node:assert/strict";
import { sanitizeUiTokens, appRootFontSize } from "./app-ui-context.ts";
import { childBridge } from "./app-child-bridge.ts";
import { childDocument } from "./app-artifact.ts";

void test("UI context exports only bounded semantic values, never arbitrary CSS or identity", () => {
  assert.deepEqual(
    sanitizeUiTokens({
      "--text-primary": "#123456",
      "--rada-font-body": '-apple-system, "Segoe UI", sans-serif',
      "--telegram-user-id": "101",
      "--private-wallet": "private",
      "--rada-os-search-icon": "url(https://outside.example/icon)",
      "--surface-base": "red; color: green",
      "--glass-fill": "x".repeat(513),
    }),
    {
      "--text-primary": "#123456",
      "--rada-font-body": '-apple-system, "Segoe UI", sans-serif',
    },
  );
  const html = childDocument(
    "https://host.example",
    "channel",
    "<main></main>",
  );
  assert.match(html, /subscribeContext/);
  assert.match(html, /event.source !== parent/);
  assert.match(html, /message.channel !== state.channel/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotThrow(
    () => new Script(childBridge("https://host.example", "channel")),
  );
});

void test("root text scaling crosses as a bounded resolved size, not another percentage", () => {
  assert.equal(appRootFontSize("20px"), 20);
  assert.equal(appRootFontSize("400px"), 32);
  assert.equal(appRootFontSize("-1px"), 12);
  assert.equal(appRootFontSize("invalid"), 16);
});

function bridgeFixture() {
  const handlers = new Map<string, ((event: unknown) => void)[]>();
  const sent: { type: string; requestId?: string }[] = [];
  const parent = {
    postMessage(message: (typeof sent)[number]) {
      sent.push(message);
    },
  };
  const document = { activeElement: null };
  class Element {
    ownerDocument = document;
    focus() {}
  }
  class Dialog extends Element {
    isConnected = true;
    open = false;
    fail = false;
    addEventListener() {}
    removeEventListener() {}
    close() {
      this.open = false;
    }
    showModal() {
      if (this.fail) throw Error("InvalidStateError");
      this.open = true;
    }
  }
  const listen = (name: string, callback: (event: unknown) => void) => {
    handlers.set(name, [...(handlers.get(name) ?? []), callback]);
  };
  Object.assign(document, { addEventListener: listen });
  const window: {
    rada?: {
      member: {
        openDialog(dialog: Dialog): Promise<boolean>;
        back(): void;
      };
    };
  } = {};
  const emit = (name: string, event: unknown) => {
    for (const callback of handlers.get(name) ?? []) callback(event);
  };
  const script = new Script(childBridge("https://host.example", "channel"));
  script.runInNewContext({
    parent,
    document,
    window,
    HTMLElement: Element,
    HTMLDialogElement: Dialog,
    addEventListener: listen,
    setTimeout,
    clearTimeout,
  });
  assert.ok(window.rada);
  return {
    Dialog,
    sent,
    last() {
      const message = sent.at(-1);
      assert.ok(message);
      return message;
    },
    member: window.rada.member,
    reply(request: (typeof sent)[number], result: unknown) {
      emit("message", {
        source: parent,
        origin: "https://host.example",
        data: {
          bridgeVersion: 1,
          channel: "channel",
          type: "rada.member.result",
          requestId: request.requestId,
          result,
        },
      });
    },
    dispose() {
      emit("pagehide", { persisted: false });
    },
  };
}

void test("failed native dialog opening releases the acknowledged host layer", async () => {
  const fixture = bridgeFixture();
  const dialog = new fixture.Dialog();
  dialog.fail = true;
  const opened = fixture.member.openDialog(dialog);
  fixture.reply(fixture.last(), { opened: true });
  assert.equal(await opened, false);
  assert.equal(fixture.sent.at(-1)?.type, "rada.member.layer.close");
  fixture.reply(fixture.last(), { closed: true });
  dialog.isConnected = false;
  const count = fixture.sent.length;
  assert.equal(await fixture.member.openDialog(dialog), false);
  assert.equal(fixture.sent.length, count);
  fixture.dispose();
});

void test("cancelled pending opening cannot clear or claim another dialog", async () => {
  const fixture = bridgeFixture();
  const first = new fixture.Dialog();
  const second = new fixture.Dialog();
  const opening = fixture.member.openDialog(first);
  const firstRequest = fixture.last();
  fixture.member.back();
  fixture.reply(fixture.last(), { closed: true });
  assert.equal(await fixture.member.openDialog(second), false);
  fixture.reply(firstRequest, { opened: true });
  assert.equal(await opening, false);
  fixture.reply(fixture.last(), { closed: true });
  const reopened = fixture.member.openDialog(second);
  fixture.reply(fixture.last(), { opened: true });
  assert.equal(await reopened, true);
  assert.equal(second.open, true);
  fixture.member.back();
  fixture.reply(fixture.last(), { closed: true });
  fixture.dispose();
});
