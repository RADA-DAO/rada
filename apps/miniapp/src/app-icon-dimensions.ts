const square = (width: number, height: number) =>
  Number.isFinite(width) && width > 0 && width <= 1024 && width === height;

function svgDimensions(bytes: Uint8Array): boolean {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  // Inspect only the root, never a nested SVG or text inside a comment.
  const root =
    /^\s*(?:<\?xml\s[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?=\s|\/?>)((?:[^>"']|"[^"]*"|'[^']*')*)>/u.exec(
      source,
    );
  if (!root) return false;
  let attributes = (root[1] ?? "").replace(/\/\s*$/u, "");
  const values = new Map<string, string>();
  while (attributes.trim()) {
    const attribute = /^\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(
      attributes,
    );
    if (!attribute || values.has(attribute[1] as string)) return false;
    values.set(attribute[1] as string, attribute[2] ?? attribute[3] ?? "");
    attributes = attributes.slice(attribute[0].length);
  }
  const viewBox = values.get("viewBox");
  let hasDimensions = false;
  if (viewBox !== undefined) {
    const parts = viewBox.trim().split(/[\s,]+/u);
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;
    if (parts.length !== 4 || parts.some((part) => !number.test(part)))
      return false;
    const [x, y, width, height] = parts.map(Number) as [
      number,
      number,
      number,
      number,
    ];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !square(width, height))
      return false;
    hasDimensions = true;
  }
  const length = (value: string) =>
    /^(?:\d+\.?\d*|\.\d+)(?:px)?$/u.test(value.trim())
      ? Number(value.trim().replace(/px$/u, ""))
      : NaN;
  const width = values.get("width");
  const height = values.get("height");
  if (width !== undefined || height !== undefined) {
    if (
      width === undefined ||
      height === undefined ||
      !square(length(width), length(height))
    )
      return false;
    hasDimensions = true;
  }
  return hasDimensions;
}

/** Header inspection only: image decoding remains the browser's responsibility. */
export function hasSquareIconDimensions(
  bytes: Uint8Array,
  type: string,
): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, text: string) =>
    Array.from(text).every(
      (char, index) => bytes[offset + index] === char.charCodeAt(0),
    );
  if (type === "image/svg+xml") return svgDimensions(bytes);
  if (type === "image/png") {
    if (
      bytes.length < 33 ||
      !tag(0, "\x89PNG\r\n\x1a\n") ||
      view.getUint32(8) !== 13 ||
      !tag(12, "IHDR")
    )
      return false;
    return square(view.getUint32(16), view.getUint32(20));
  }
  if (
    type !== "image/webp" ||
    bytes.length < 20 ||
    !tag(0, "RIFF") ||
    !tag(8, "WEBP") ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return false;
  const size = view.getUint32(16, true);
  if (20 + size > bytes.length) return false;
  const uint24 = (offset: number) =>
    view.getUint16(offset, true) + view.getUint8(offset + 2) * 65536;
  if (tag(12, "VP8X") && size === 10)
    return square(uint24(24) + 1, uint24(27) + 1);
  if (
    tag(12, "VP8 ") &&
    size >= 10 &&
    (view.getUint8(20) & 1) === 0 &&
    tag(23, "\x9d\x01\x2a")
  )
    return square(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
  if (tag(12, "VP8L") && size >= 5 && view.getUint8(20) === 0x2f) {
    const bits = view.getUint32(21, true);
    return (
      bits >>> 29 === 0 &&
      square((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    );
  }
  return false;
}
