export const FROG_CARD_WIDTH = 800 as const;
export const FROG_CARD_HEIGHT = 1000 as const;
export const FROG_CARD_ASPECT_RATIO = "4 / 5" as const;
export const FROG_CARD_CUTOUT_PATH =
  "M4.5 0H80.2Q83.2 0 83.2 3V27Q83.2 30 86.2 30H95.5Q100 30 100 34.5V120.5Q100 125 95.5 125H4.5Q0 125 0 120.5V4.5Q0 0 4.5 0Z" as const;

export const FROG_CARD_CUTOUT_GEOMETRY = {
  axisXPercent: 91.047,
  heightWidthPercent: 30,
  lilySizeWidthPercent: 14.5,
  lilyCenterYWidthPercent: 9.181,
  sparkCenterYWidthPercent: 22.667,
  sparkHeightWidthPercent: 7.5,
  sparkBadgeWidthPercent: 14.833,
} as const;

export function frogCardName(value: string): string {
  return value.trim().replace(/^@+/, "").toUpperCase() || "IDENTITY_PENDING";
}
