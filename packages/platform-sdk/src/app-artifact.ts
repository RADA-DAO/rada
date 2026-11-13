import { childBridge } from "./app-child-bridge.ts";
import type { AppContext } from "./app-ui-context.ts";
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
  context?: AppContext,
): string {
  const bridge = childBridge(hostOrigin, channel, context);
  // The opaque iframe has no same-origin storage. This policy blocks fetch, frames,
  // forms and remote assets even when the artifact contains another CSP declaration.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'"><meta name="referrer" content="no-referrer"><script>${bridge.replace(/<\/script/gi, "<\\/script")}</script></head><body>${artifact}</body></html>`;
}
