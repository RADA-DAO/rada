import type { AppContext } from "./app-ui-context.ts";

/** Self-contained function: serialized into the opaque document, with no imports. */
function bootstrap(state: {
  hostOrigin: string;
  channel: string;
  context?: AppContext;
}) {
  let seq = 0;
  let opening = false;
  let activeDialog: HTMLDialogElement | null = null;
  let opener: HTMLElement | null = null;
  let activeClose: (() => void) | null = null;
  const closeDialog = () => {
    const dialog = activeDialog;
    if (dialog && activeClose) dialog.removeEventListener("close", activeClose);
    activeClose = null;
    activeDialog = null;
    if (dialog?.open) dialog.close();
    opener?.focus({ preventScroll: true });
  };
  let context = state.context;
  let tokenNames: string[] = [];
  const listeners = new Set<(value: AppContext) => void>();
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  const send = (message: Record<string, unknown>) => {
    parent.postMessage(
      { ...message, bridgeVersion: 1, channel: state.channel },
      state.hostOrigin,
    );
  };
  const apply = (value: AppContext) => {
    context = value;
    const root = document.documentElement;
    root.lang = value.locale;
    root.style.fontSize = `${String(value.ui.rootFontSize)}px`;
    for (const name of tokenNames)
      if (!(name in value.ui.tokens)) root.style.removeProperty(name);
    tokenNames = Object.keys(value.ui.tokens);
    for (const [name, token] of Object.entries(value.ui.tokens))
      root.style.setProperty(name, token);
    for (const [side, inset] of Object.entries(value.ui.safeArea))
      root.style.setProperty(`--app-safe-${side}`, `${String(inset)}px`);
    root.style.setProperty(
      "--app-visible-height",
      `${String(value.ui.viewport.visibleHeight)}px`,
    );
    root.style.setProperty(
      "--app-keyboard-inset",
      `${String(value.ui.viewport.keyboardInset)}px`,
    );
    root.dataset.reducedMotion = String(value.ui.reducedMotion);
    for (const listener of listeners) listener(value);
    document.dispatchEvent(new CustomEvent("rada:context", { detail: value }));
  };
  if (context) apply(context);
  const request = (type: string, payload: unknown = {}) => {
    if (typeof type !== "string" || !type.startsWith("rada.member."))
      return Promise.reject(Error("invalid_request"));
    const requestId = "r" + String(++seq);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          pending.delete(requestId);
          reject(Error("timeout"));
        },
        [
          "rada.member.payment.request",
          "rada.member.report",
          "rada.member.permission.request",
        ].includes(type)
          ? 300000
          : 10000,
      );
      pending.set(requestId, { resolve, reject, timeout });
      send({ type, requestId, payload });
    });
  };
  Object.assign(window, {
    rada: Object.freeze({
      member: Object.freeze({
        request,
        async openDialog(
          dialog: HTMLDialogElement,
          explicitOpener?: HTMLElement,
        ) {
          if (
            opening ||
            activeDialog ||
            !(dialog instanceof HTMLDialogElement) ||
            !dialog.isConnected ||
            dialog.open
          )
            return false;
          opening = true;
          activeDialog = dialog;
          opener =
            explicitOpener instanceof HTMLElement &&
            explicitOpener.ownerDocument === document
              ? explicitOpener
              : document.activeElement instanceof HTMLElement
                ? document.activeElement
                : null;
          const previous = opener;
          activeClose = () => {
            if (activeDialog !== dialog) return;
            activeDialog = null;
            activeClose = null;
            void request("rada.member.layer.close").catch(() => {});
            previous?.focus({ preventScroll: true });
          };
          dialog.addEventListener("close", activeClose, { once: true });
          try {
            const result = (await request("rada.member.layer.open")) as {
              opened?: boolean;
            };
            if (!result.opened || activeDialog !== dialog) {
              if (activeDialog === dialog) closeDialog();
              if (result.opened)
                void request("rada.member.layer.close").catch(() => {});
              return false;
            }
            dialog.showModal();
            return true;
          } catch {
            if (activeDialog === dialog) closeDialog();
            void request("rada.member.layer.close").catch(() => {});
            return false;
          } finally {
            opening = false;
          }
        },
        subscribeContext(listener: (value: AppContext) => void) {
          listeners.add(listener);
          if (context) listener(context);
          return () => {
            listeners.delete(listener);
          };
        },
        back() {
          if (activeDialog) {
            closeDialog();
            void request("rada.member.layer.close").catch(() => {});
          } else send({ type: "rada.member.navigation.back" });
        },
      }),
    }),
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== state.hostOrigin) return;
    const message = event.data as {
      bridgeVersion?: number;
      channel?: string;
      type?: string;
      context?: AppContext;
      requestId?: string;
      result?: unknown;
      error?: string;
    } | null;
    if (
      !message ||
      message.bridgeVersion !== 1 ||
      message.channel !== state.channel
    )
      return;
    if (message.type === "rada.member.layer.dismiss") {
      closeDialog();
      return;
    }
    if (message.type === "rada.member.context.changed" && message.context) {
      apply(message.context);
      return;
    }
    const request = pending.get(message.requestId ?? "");
    if (!request) return;
    clearTimeout(request.timeout);
    pending.delete(message.requestId ?? "");
    if (message.type === "rada.member.result") request.resolve(message.result);
    else if (message.type === "rada.member.error")
      request.reject(Error(message.error));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.isComposing || event.defaultPrevented)
      return;
    event.preventDefault();
    if (activeDialog) {
      closeDialog();
      void request("rada.member.layer.close").catch(() => {});
    } else send({ type: "rada.member.navigation.back" });
  });
  addEventListener("pagehide", (event) => {
    if (event.persisted) return;
    listeners.clear();
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(Error("disposed"));
    }
    pending.clear();
  });
  send({ type: "rada.member.boot" });
}

export function childBridge(
  hostOrigin: string,
  channel: string,
  context?: AppContext,
): string {
  return `(${bootstrap.toString()})(${JSON.stringify({ hostOrigin, channel, context }).replace(/</g, "\\u003c")});`;
}
