import type { SheetNavigation } from "../../ui/src/index.ts";
import { consentWindow } from "./app-host-consent.ts";
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
  requestPayment?(
    appId: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  paymentStatus?(appId: string, intentId: string): Promise<unknown>;
  onNavigateBack?(): void;
  /** Platform stack, so permission prompts close with Back, Escape and swipe. */
  navigation?: SheetNavigation;
  onError?(code: string): void;
};
const maxArtifactBytes = 1024 * 1024;
const allowedRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const isAppPermission = (value: unknown): value is AppPermission =>
  typeof value === "string" &&
  (APP_PERMISSIONS as readonly string[]).includes(value);
const isConsentPermission = (
  value: unknown,
): value is (typeof CONSENT_PERMISSIONS)[number] =>
  typeof value === "string" &&
  (CONSENT_PERMISSIONS as readonly string[]).includes(value);
export async function verifyAppArtifact(
  response: Response,
  expectedHash: string,
): Promise<string> {
  if (!response.ok || !/^[a-f0-9]{64}$/.test(expectedHash))
    throw new Error("artifact_unavailable");
  const size = Number(response.headers.get("content-length"));
  if (size > maxArtifactBytes) throw new Error("artifact_too_large");
  const body: unknown = response.body;
  if (!(body instanceof ReadableStream))
    throw new Error("artifact_unavailable");
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
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
    const requestId = 'r' + (++seq); return new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending.delete(requestId); reject(Error('timeout')); }, type === 'rada.member.payment.request' ? 300000 : 10000); pending.set(requestId, { resolve, reject, timeout }); send({ type, requestId, payload }); }); },
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
  const rawRelease: unknown = release;
  if (!rawRelease || typeof rawRelease !== "object")
    throw new Error("invalid_release");
  const rawGrants: unknown = release.grantedPermissions;
  const manifest = parseAppManifest(release.manifest);
  if (!/^[a-z][a-z0-9_.:-]{0,127}$/.test(release.appId))
    throw new Error("invalid_release");
  if (
    typeof (release.artifactUrl as unknown) !== "string" ||
    typeof (options.artifactOrigin as unknown) !== "string" ||
    typeof (release.artifactSha256 as unknown) !== "string" ||
    !/^[a-f0-9]{64}$/.test(release.artifactSha256) ||
    !Array.isArray(rawGrants) ||
    release.grantedPermissions.length > APP_PERMISSIONS.length ||
    rawGrants.some((permission: unknown) => !isAppPermission(permission)) ||
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
  const isDisposed = () => disposed;
  const isActive = () => active;
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
    while (times[0] !== undefined && times[0] < now - 60_000) times.shift();
    if (pending.has(id) || pending.size >= 4 || times.length >= 30) {
      reply(id, "rada.member.error", { error: "rate_limited" });
      return;
    }
    times.push(now);
    pending.add(id);
    const controller = new AbortController();
    const isAborted = () => controller.signal.aborted;
    controllers.set(id, controller);
    const timeout = setTimeout(
      () => {
        controller.abort();
      },
      message.type === "rada.member.payment.request" ? 300000 : 10000,
    );
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
      if (message.type === "rada.member.payment.request") {
        if (
          !granted.has("money.transfer") ||
          !options.requestPayment ||
          promptOwner
        )
          throw new Error("capability_denied");
        promptOwner = id;
        try {
          return await options.requestPayment(
            release.appId,
            message.payload,
            controller.signal,
          );
        } finally {
          if (promptOwner === id) promptOwner = null;
        }
      }
      if (message.type === "rada.member.payment.status") {
        if (!granted.has("money.transfer") || !options.paymentStatus)
          throw new Error("capability_denied");
        const payload = message.payload;
        const intentId =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).intentId
            : null;
        if (typeof intentId !== "string") throw new Error("capability_denied");
        return options.paymentStatus(release.appId, intentId);
      }
      if (message.type === "rada.member.permission.request") {
        const payload = message.payload;
        const permission =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as Record<string, unknown>).permission
            : null;
        if (!isConsentPermission(permission) || !granted.has(permission))
          throw new Error("capability_denied");
        if (promptOwner) throw new Error("rate_limited");
        promptOwner = id;
        try {
          if (await options.readConsent(release.appId, permission))
            return { granted: true };
          if (isAborted() || isDisposed() || !isActive())
            throw new Error("timeout");
          const accepted = await consentWindow(
            options.consentCopy(permission, manifest.name),
            controller.signal,
            options.navigation,
          );
          if (isAborted() || isDisposed() || !isActive())
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
      .then((result) => {
        reply(id, "rada.member.result", { result });
      })
      .catch((error: unknown) => {
        reply(id, "rada.member.error", {
          error:
            error instanceof Error &&
            ["capability_denied", "rate_limited", "timeout"].includes(
              error.message,
            )
              ? error.message
              : "request_failed",
        });
      })
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
