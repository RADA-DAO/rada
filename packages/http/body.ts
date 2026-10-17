export class BodyTooLarge extends Error {}

/** Reads at most limit bytes, cancelling as soon as a chunk exceeds the budget. */
export async function readBoundedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (Number(request.headers.get("content-length")) > limit) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new BodyTooLarge();
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
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  return JSON.parse(
    new TextDecoder().decode(await readBoundedBody(request, limit)),
  ) as unknown;
}
