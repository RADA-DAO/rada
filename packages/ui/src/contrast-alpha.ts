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
