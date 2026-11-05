/** How far a finger may retreat from its furthest point and still commit the turn. */
export const SLIDE_PULLBACK_PX = 28;

/** Next page travels negative (left / up). Horizontal RTL mirrors that. */
export function slideSign(
  direction: 'next' | 'prev',
  axis: 'horizontal' | 'vertical',
  rtl: boolean,
): 1 | -1 {
  const mirrored = axis === 'horizontal' && rtl;
  return (direction === 'next') === !mirrored ? -1 : 1;
}

/** Keep the drag on the commit side of rest, and within one viewport. */
export function clampSlideOffset(delta: number, sign: 1 | -1, distance: number): number {
  if (distance <= 0) return 0;
  return sign < 0 ? clamp(delta, -distance, 0) : clamp(delta, 0, distance);
}

/**
 * Release commits the turn. It cancels only when the finger has pulled back
 * more than `tolerance` px from the furthest point reached, or never moved.
 */
export function slideShouldCommit(
  offset: number,
  peak: number,
  sign: 1 | -1,
  tolerance: number,
): boolean {
  if (Math.abs(peak) < 1) return false;
  const pullback = sign < 0 ? offset - peak : peak - offset;
  return pullback <= tolerance;
}

/** 0 at rest, 1 when the page has traveled a full viewport. */
export function slideColorProgress(offset: number, distance: number): number {
  if (!(distance > 0)) return 0;
  return Math.min(1, Math.abs(offset) / distance);
}

/** Offset along a settle animation. `eased` is the animation's transformed progress. */
export function slideSettleOffset(from: number, to: number, eased: number): number {
  const t = Math.min(1, Math.max(0, eased));
  return from + (to - from) * t;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
