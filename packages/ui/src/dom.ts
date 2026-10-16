/** Shared DOM helpers for the components. Not part of the public API. */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

let sequence = 0;
export function uniqueId(prefix: string): string {
  return `${prefix}-${String(++sequence)}`;
}
