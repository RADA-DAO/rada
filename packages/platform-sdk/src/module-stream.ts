export type ModuleStreamEvent = {
  event: string;
  data: unknown;
  id: string | null;
};
export type ModuleStreamOptions = {
  signal?: AbortSignal;
  onEvent(event: ModuleStreamEvent): void;
};

/** Lazy platform transport; credentials never enter module screen code. */
export async function openModuleStream(
  target: string,
  options: ModuleStreamOptions,
  authHeaders: () => { Authorization: string } | null,
) {
  const credential = authHeaders()?.Authorization;
  if (!credential) throw new Error("expired");
  const response = await fetch(target, {
    headers: { Authorization: credential, Accept: "text/event-stream" },
    credentials: "omit",
    cache: "no-store",
    signal: options.signal ?? null,
  });
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.startsWith("text/event-stream")
  ) {
    await response.body?.cancel();
    throw new Error(response.status === 401 ? "expired" : "unavailable");
  }
  await readModuleStream(
    response.body,
    options,
    () => authHeaders()?.Authorization === credential,
  );
}

/** Bounded SSE decoding; credentials and reconnect policy stay outside the parser. */
export async function readModuleStream(
  body: ReadableStream<Uint8Array>,
  options: ModuleStreamOptions,
  current: () => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const limit = 64 * 1024;
  let buffer = "";
  let event = "message";
  let id: string | null = null;
  let data: string[] = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  const line = (value: string) => {
    if (!value) {
      if (data.length && current() && !options.signal?.aborted) {
        options.onEvent({
          event,
          id,
          data: JSON.parse(data.join("\n")) as unknown,
        });
      }
      event = "message";
      data = [];
      size = 0;
      return;
    }
    size += value.length;
    if (size > limit) throw new Error("stream_too_large");
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const key = colon < 0 ? value : value.slice(0, colon);
    const raw = colon < 0 ? "" : value.slice(colon + 1);
    const content = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (key === "data") data.push(content);
    else if (key === "event") event = content;
    else if (key === "id" && !content.includes("\0")) id = content;
  };
  try {
    while (!options.signal?.aborted && current()) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // Parse CR, LF and CRLF, including CRLF split across network chunks.
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[end] === "\r" && end === buffer.length - 1) break;
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + width);
      }
      if (buffer.length + size > limit) throw new Error("stream_too_large");
    }
    // An unterminated event is intentionally discarded; reconnect uses the last receipt.
    if (!current()) throw new Error("expired");
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
