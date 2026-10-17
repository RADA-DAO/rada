const maxArtifactBytes = 1024 * 1024;
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

export function childDocument(
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
    const requestId = 'r' + (++seq); return new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending.delete(requestId); reject(Error('timeout')); }, ['rada.member.payment.request','rada.member.report','rada.member.permission.request'].includes(type) ? 300000 : 10000); pending.set(requestId, { resolve, reject, timeout }); send({ type, requestId, payload }); }); },
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
