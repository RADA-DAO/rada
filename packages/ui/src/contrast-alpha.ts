/** Increase translucent ink opacity until it reads on every material stop. */
export function contrastAlpha(
  ink: readonly number[],
  backgrounds: readonly (readonly number[])[],
  initial: number,
  contrast: (first: string, second: string) => number,
): number {
  const hex = (rgb: readonly number[]) =>
    `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
  // Leave room for quiet shadows below the material stops in the painted UI.
  for (let step = Math.round(initial * 100); step < 100; step++) {
    const alpha = step / 100;
    if (
      backgrounds.every((background) => {
        const composite = ink.map(
          (c, i) => c * alpha + (background[i] ?? 0) * (1 - alpha),
        );
        return contrast(hex(composite), hex(background)) >= 5;
      })
    )
      return alpha;
  }
  return 1;
}

/** Keep each semantic material readable without modifying either authored HEX.
 * Only a failing stop moves, by the smallest sRGB mix toward the readable pole.
 * The per-palette cache keeps repeated aliases identical and bounds its lifetime.
 */
export function surfaceContrastGuard(
  ink: string,
  contrast: (first: string, second: string) => number,
): (surface: string) => string {
  const target = 5;
  const pole = contrast(ink, "#FFFFFF") >= contrast(ink, "#000000") ? 255 : 0;
  const cache = new Map<string, string>();
  return (surface) => {
    const previous = cache.get(surface);
    if (previous) return previous;
    if (contrast(surface, ink) >= target) return surface;
    const rgb = [1, 3, 5].map((offset) =>
      Number.parseInt(surface.slice(offset, offset + 2), 16),
    );
    const mix = (fraction: number) =>
      `#${rgb
        .map((channel) =>
          Math.round(channel + (pole - channel) * fraction)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")}`.toUpperCase();
    let low = 0;
    let high = 1;
    for (let step = 0; step < 12; step++) {
      const middle = (low + high) / 2;
      if (contrast(mix(middle), ink) >= target) high = middle;
      else low = middle;
    }
    const result = mix(high);
    cache.set(surface, result);
    return result;
  };
}

/** Resolve a translucent pigment once, before stacking it on an ambient canvas. */
export function blendSurface(
  base: string,
  pigment: string,
  alpha: number,
): string {
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(
        parseInt(base.slice(i, i + 2), 16) * (1 - alpha) +
          parseInt(pigment.slice(i, i + 2), 16) * alpha,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}
