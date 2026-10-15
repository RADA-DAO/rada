import { Button, Sheet } from "../../ui/src/index.ts";
import {
  APP_PERMISSIONS,
  CONSENT_PERMISSIONS,
  parseAppManifest,
  type AppManifest,
  type AppPermission,
} from "./app-manifest.ts";

export type AppRelease = {
  appId: string;
  manifest: AppManifest;
  artifactUrl: string;
  artifactSha256: string;
  // Derived by the trusted release registry, never by rada.app.json or a child message.
  grantedPermissions: readonly AppPermission[];
};
export type ConsentCopy = {
  title: string;
  description: string;
  allow: string;
  deny: string;
};
export type AppHostOptions = {
  signal?: AbortSignal;
  release: AppRelease;
  container: HTMLElement;
  artifactOrigin: string;
  locale: "en" | "uk";
  consentCopy(permission: string, appName: string): ConsentCopy;
  readConsent(appId: string, permission: string): Promise<boolean>;
  writeConsent(
    appId: string,
    permission: string,
    granted: boolean,
  ): Promise<boolean>;
  ownSubject(): Promise<string | null>;
  readWalletAddress?(appId: string, signal: AbortSignal): Promise<unknown>;
  readWalletBalances?(appId: string, signal: AbortSignal): Promise<unknown>;
  onNavigateBack?(): void;
  onError?(code: string): void;
};
const maxArtifactBytes = 1024 * 1024;
const allowedRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export async function verifyAppArtifact(
  response: Response,
  expectedHash: string,
): Promise<string> {
  if (!response.ok || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error("artifact_unavailable");
  const size = Number(response.headers.get("content-length"));
  if (size > maxArtifactBytes) throw new Error("artifact_too_large");
  if (!response.body) throw new Error("artifact_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > maxArtifactBytes) {
        await reader.cancel();
        throw new Error("artifact_too_large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== expectedHash) throw new Error("artifact_integrity_failed");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function consentWindow(
  copy: ConsentCopy,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let result = false;
    const description = document.createElement("p");
    description.textContent = copy.description;
    const allow = Button(copy.allow, {
      onClick: () => {
        result = true;
        dialog.close();
      },
    });
    const dialog = Sheet({
      title: copy.title,
      closeLabel: copy.deny,
      children: [description, allow],
    });
    const abort = () => dialog.close();
    signal.addEventListener("abort", abort, { once: true });
    dialog.addEventListener(
      "close",
      () => {
        signal.removeEventListener("abort", abort);
        dialog.remove();
        resolve(result && !signal.aborted);
      },
      { once: true },
    );
    document.body.append(dialog);
    dialog.showModal();
  });
}

function childDocument(
  hostOrigin: string,
  channel: string,
  artifact: string,
): string {
  const state = JSON.stringify({ hostOrigin, channel }).replace(
    /</g,
    "\\u003c",
  );
  const bridge = `(() => { const state = ${state}; let seq = 0; const pending = new Map();
    const send = (message) => parent.postMessage({ ...message, bridgeVersion: 1, channel: state.channel }, state.hostOrigin);
    window.rada = Object.freeze({ member: Object.freeze({
      request(type, payload = {}) { if (typeof type !== 'string' || !type.startsWith('rada.member.')) return Promise.reject(Error('invalid_request'));
        const requestId = 'r' + (++seq); return new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending.delete(requestId); reject(Error('timeout')); }, 10000); pending.set(requestId, { resolve, reject, timeout }); send({ type, requestId, payload }); }); },
      back() { send({ type: 'rada.member.navigation.back' }); }
    }) });
    addEventListener('message', event => { if (event.source !== parent || event.origin !== state.hostOrigin) return;
      const message = event.data; if (!message || message.bridgeVersion !== 1 || message.channel !== state.channel) return;
      const request = pending.get(message.requestId); if (!request) return;
      clearTimeout(request.timeout); pending.delete(message.requestId);
      if (message.type === 'rada.member.result') request.resolve(message.result);
      else if (message.type === 'rada.member.error') request.reject(Error(message.error));
    }); send({ type: 'rada.member.boot' });
  })();`;
  // The opaque iframe has no same-origin storage. This policy blocks fetch, frames,
  // forms and remote assets even when the artifact contains another CSP declaration.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><script>${bridge.replace(/<\/script/gi, "<\\/script")}</script></head><body>${artifact}</body></html>`;
}

export async function mountAppHost(
  options: AppHostOptions,
): Promise<() => void> {
  const { release } = options;
  if (!release || typeof release !== "object")
    throw new Error("invalid_release");
  const manifest = parseAppManifest(release.manifest);
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(release.appId))
    throw new Error("invalid_release");
  if (
    typeof release.artifactUrl !== "string" ||
    typeof options.artifactOrigin !== "string" ||
    typeof release.artifactSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(release.artifactSha256) ||
    !Array.isArray(release.grantedPermissions) ||
    release.grantedPermissions.length > APP_PERMISSIONS.length ||
    release.grantedPermissions.some(
      (permission) =>
        typeof permission !== "string" ||
        !APP_PERMISSIONS.includes(permission as AppPermission),
    ) ||
    new Set(release.grantedPermissions).size !==
      release.grantedPermissions.length
  )
    throw new Error("invalid_release");
  let url: URL;
  let origin: URL;
  try {
    url = new URL(release.artifactUrl);
    origin = new URL(options.artifactOrigin);
  } catch {
    throw new Error("invalid_artifact_origin");
  }
  if (
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !["127.0.0.1", "localhost"].includes(url.hostname))
  )
    throw new Error("invalid_artifact_origin");
  if (
    release.grantedPermissions.some(
      (permission) => !manifest.permissions.includes(permission),
    )
  )
    throw new Error("invalid_release");
  const response = await fetch(url.href, {
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  const artifact = await verifyAppArtifact(response, release.artifactSha256);
  options.signal?.throwIfAborted();
  const channel = crypto.randomUUID();
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("allow", "");
  frame.srcdoc = childDocument(location.origin, channel, artifact);
  frame.title = manifest.name;
  const granted = new Set(release.grantedPermissions);
  const pending = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const times: number[] = [];
  let disposed = false;
  let active = true;
  let promptOwner: string | null = null;
  const reply = (
    requestId: string,
    type: string,
    body: Record<string, unknown>,
  ) => {
    if (!disposed && active)
      frame.contentWindow?.postMessage(
        { type, requestId, channel, bridgeVersion: 1, ...body },
        "*",
      );
  };
  const onLoad = () => {
    if (frame.dataset.loaded === "true") active = false;
    frame.dataset.loaded = "true";
  };
  frame.addEventListener("load", onLoad);
  const onMessage = (event: MessageEvent) => {
    if (
      disposed ||
      !active ||
      event.source !== frame.contentWindow ||
      event.origin !== "null"
    )
      return;
    const value: unknown = event.data;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (
      message.bridgeVersion !== 1 ||
      message.channel !== channel ||
      typeof message.type !== "string"
    )
      return;
    if (message.type === "rada.member.boot") return;
    if (message.type === "rada.member.navigation.back") {
      if (granted.has("navigation")) options.onNavigateBack?.();
      return;
    }
    if (!allowedRequestId(message.requestId)) return;
    const id = message.requestId;
    const now = Date.now();
    while (times.length && times[0] < now - 60_000) times.shift();
    if (pending.has(id) || pending.size >= 4 || times.length >= 30) {
      reply(id, "rada.member.error", { error: "rate_limited" });
      return;
    }
    times.push(now);
    pending.add(id);
    const controller = new AbortController();
    controllers.set(id, controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    const run = async () => {
      if (message.type === "rada.member.context.get")
        return { locale: options.locale };
      if (
        message.type === "rada.member.identity.self" &&
        granted.has("identity.self.read")
      )
        return { subjectId: await options.ownSubject() };
      if (message.type === "rada.member.wallet.address.read") {
        if (
          !granted.has("wallet.address.read") ||
          !options.readWalletAddress ||
          !(await options.readConsent(release.appId, "wallet.address.read"))
        )
          throw new Error("capability_denied");
        return options.readWalletAddress(release.appId, controller.signal);
      }
      if (message.type === "rada.member.wallet.balances.read") {
        if (
          !granted.has("wallet.balances.read") ||
          !options.readWalletBalances ||
          !(await options.readConsent(release.appId, "wallet.balances.read"))
        )
          throw new Error("capability_denied");
        return options.readWalletBalances(release.appId, controller.signal);
      }
      if (message.type === "rada.member.permission.request") {
        const payload = message.payload;
        const permission =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).permission
            : null;
        if (
          typeof permission !== "string" ||
          !CONSENT_PERMISSIONS.includes(
            permission as (typeof CONSENT_PERMISSIONS)[number],
          ) ||
          !granted.has(permission as AppPermission)
        )
          throw new Error("capability_denied");
        if (promptOwner) throw new Error("rate_limited");
        promptOwner = id;
        try {
          if (await options.readConsent(release.appId, permission))
            return { granted: true };
          if (controller.signal.aborted || disposed || !active)
            throw new Error("timeout");
          const accepted = await consentWindow(
            options.consentCopy(permission, manifest.name),
            controller.signal,
          );
          if (controller.signal.aborted || disposed || !active)
            throw new Error("timeout");
          if (!accepted) return { granted: false };
          return {
            granted: await options.writeConsent(
              release.appId,
              permission,
              true,
            ),
          };
        } finally {
          if (promptOwner === id) promptOwner = null;
        }
      }
      // Financial, signature and governance actions have no implementation in v1.
      throw new Error("capability_denied");
    };
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          if (promptOwner === id) promptOwner = null;
          reject(new Error("timeout"));
        },
        { once: true },
      );
    });
    void Promise.race([run(), aborted])
      .then((result) => reply(id, "rada.member.result", { result }))
      .catch((error: unknown) =>
        reply(id, "rada.member.error", {
          error:
            error instanceof Error &&
            ["capability_denied", "rate_limited", "timeout"].includes(
              error.message,
            )
              ? error.message
              : "request_failed",
        }),
      )
      .finally(() => {
        clearTimeout(timeout);
        pending.delete(id);
        controllers.delete(id);
      });
  };
  window.addEventListener("message", onMessage);
  options.container.replaceChildren(frame);
  return () => {
    disposed = true;
    active = false;
    for (const controller of controllers.values()) controller.abort();
    window.removeEventListener("message", onMessage);
    frame.removeEventListener("load", onLoad);
    pending.clear();
    frame.remove();
  };
}
