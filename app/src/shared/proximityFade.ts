/**
 * Fading a floating card out of the pointer's way.
 *
 * The in-app toasts and the auto-switch overlay both sit in a bottom-right
 * corner, over whatever someone is working on, and both fade as the pointer
 * comes near so what is underneath stays readable. Same numbers in both, so
 * they behave as one thing: each sets `--prox` (0..1) on its card, and the
 * card's CSS turns that into `opacity: calc(MIN + (1 - MIN) * var(--prox))`.
 */

/** How far (px) from a card's own box the pointer has to be before the card
 *  is at full opacity. */
export const FADE_RADIUS_PX = 140;

/** What is left of a card with the pointer on it. */
export const MIN_OPACITY = 0.12;

export interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Shortest distance from a point to a rectangle; 0 when the point is inside. */
export function distanceToRect(x: number, y: number, r: RectLike): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/** How clear of the card the pointer is: 0 on it, 1 at `FADE_RADIUS_PX` and
 *  beyond. A card's `--prox`. */
export function proximity(x: number, y: number, r: RectLike): number {
  return Math.min(1, distanceToRect(x, y, r) / FADE_RADIUS_PX);
}
