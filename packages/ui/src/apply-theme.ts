export function applyTheme(
  root: HTMLElement,
  palette: { tokens: Record<string, string> },
): void {
  for (const [name, value] of Object.entries(palette.tokens))
    root.style.setProperty(name, value);
}
