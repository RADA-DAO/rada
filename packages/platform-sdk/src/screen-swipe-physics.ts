/** Small, deterministic helpers for the shell's horizontal screen gesture.
 *
 * The functions deliberately have no knowledge of DOM, pointer events, or
 * navigation.  Keeping the physics here makes the gesture state machine easy
 * to test and prevents rendering work from leaking into pointermove.
 */

export type SwipeAxis = "pending" | "horizontal" | "vertical";

const DEADZONE_PX = 9;
const HORIZONTAL_DOMINANCE = 1.24;
const PROJECTION_MS = 180;
const COMMIT_RATIO = 0.35;
const FLICK_VELOCITY_PX_PER_MS = 0.45;

export function resolveSwipeAxis(
  dx: number,
  dy: number,
  current: SwipeAxis,
): SwipeAxis {
  // Once intent is established it is permanent for this pointer sequence.
  if (current !== "pending") return current;

  const x = Math.abs(dx);
  const y = Math.abs(dy);
  if (Math.max(x, y) < DEADZONE_PX) return "pending";
  if (x >= y * HORIZONTAL_DOMINANCE) return "horizontal";
  // A thumb often starts slightly diagonally. Do not permanently give the
  // gesture to scrolling until its direction is clear; bound that ambiguity
  // so a diagonal scroll still belongs to the browser promptly.
  if (y >= x * HORIZONTAL_DOMINANCE || Math.max(x, y) >= 24) return "vertical";
  return "pending";
}

/** Offset used while dragging against an unavailable edge. */
export function rubberBandSwipeOffset(
  dx: number,
  width: number,
  hasTarget: boolean,
): number {
  if (hasTarget || !Number.isFinite(dx)) return dx;
  if (!Number.isFinite(width) || width <= 0 || dx === 0) return 0;

  // A damped saturating curve keeps the edge discoverable without making the
  // missing page feel reachable. The low initial slope avoids a hard tug and
  // the 22% cap reads as resistance instead of a circular carousel.
  const cap = width * 0.22;
  const responseLength = width * 0.52;
  const distance = cap * (1 - Math.exp(-Math.abs(dx) / responseLength));
  return Math.sign(dx) * distance;
}

/** Predict where the finger is going to put the screen after release. */
export function projectedSwipeOffset(dx: number, velocityX: number): number {
  const safeDx = Number.isFinite(dx) ? dx : 0;
  const safeVelocity = Number.isFinite(velocityX) ? velocityX : 0;
  return safeDx + safeVelocity * PROJECTION_MS;
}

export function shouldCommitSwipe(args: {
  dx: number;
  dy: number;
  width: number;
  velocityX: number;
  axis: SwipeAxis;
  hasTarget: boolean;
}): boolean {
  const { dx, dy, width, velocityX, axis, hasTarget } = args;
  if (axis !== "horizontal" || !hasTarget) return false;
  if (!Number.isFinite(width) || width <= 0) return false;

  const horizontalDistance = Math.abs(dx);
  const meaningfulDistance = Math.max(24, Math.min(36, width * 0.08));
  if (
    horizontalDistance < meaningfulDistance ||
    horizontalDistance < Math.abs(dy)
  ) {
    return false;
  }

  const projected = Math.abs(projectedSwipeOffset(dx, velocityX));
  const projectedSigned = projectedSwipeOffset(dx, velocityX);
  const remainsInOriginalDirection =
    projectedSigned === 0 || Math.sign(projectedSigned) === Math.sign(dx);
  if (remainsInOriginalDirection && projected >= width * COMMIT_RATIO)
    return true;

  // A flick can commit before the position threshold, but only after the meaningful
  // distance gate above; a tiny velocity spike must never navigate.
  return (
    remainsInOriginalDirection &&
    Math.sign(velocityX) === Math.sign(dx) &&
    Math.abs(velocityX) >= FLICK_VELOCITY_PX_PER_MS
  );
}

export function swipeSettleDurationMs(args: {
  remainingDistance: number;
  width: number;
  velocityX: number;
  reducedMotion: boolean;
}): number {
  if (args.reducedMotion) return 0;
  const width =
    Number.isFinite(args.width) && args.width > 0 ? args.width : 320;
  const distance = Math.max(
    0,
    Number.isFinite(args.remainingDistance) ? args.remainingDistance : 0,
  );
  if (distance === 0) return 170;

  const velocity = Math.abs(
    Number.isFinite(args.velocityX) ? args.velocityX : 0,
  );
  // Velocity is expressed in px/ms, so distance / speed is already ms.  At
  // rest, a full-width settle takes roughly 270ms. A real release speed
  // shortens it naturally while the bounds preserve a deliberate finish.
  const speed = Math.max(velocity, width / 270);
  const duration = distance / speed;
  return Math.round(Math.min(320, Math.max(170, duration)));
}
