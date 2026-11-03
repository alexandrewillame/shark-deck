import { useEffect, useRef, useState } from 'react';

/**
 * Drag-with-resistance, springing back on release.
 *
 * The device photo is a `position: fixed` node whose box (top/left/width/
 * height) is owned by the flight system — it is animated between anchors as
 * you move around the app (see PersistentDeviceArt). So this deliberately
 * reports a **transform offset** rather than touching that box: the two
 * compose, and a drag can never leave the photo stranded away from wherever
 * the flight last put it.
 *
 * Resistance is the point. A photo that follows the cursor 1:1 reads as
 * something you have picked up and might drop; one that lags and pulls back
 * reads as attached, which is what it is.
 *
 * ## The gesture is global, not on the photo
 *
 * It used to be an `onPointerDown` on the overlay itself, which meant the
 * overlay had to take pointer events — and therefore had to hand plain clicks
 * back to whatever it was covering (a device card, whose click opens that
 * device) with an `elementFromPoint` + synthetic-click dance. That machinery
 * is gone: the listener is on `window`, the overlay stays `pointer-events:
 * none` in every state, and nothing here ever calls `preventDefault`, so every
 * control underneath behaves exactly as it did. Pressing anywhere on the
 * interface tugs the photo.
 */

/** Past this, movement is heavily damped — the further you pull, the less it
 *  gives, so there is a felt limit without a hard stop. */
const SOFT_LIMIT = 26;
/** Below this the gesture was a click, and must stay one. */
const CLICK_SLOP = 4;

/**
 * Controls that own the drag gesture themselves. Sweeping a slider or
 * marquee-selecting keys must not also haul the photo around.
 *
 * `.tabstrip` is here because a tab drag reorders tabs; `.modal` because a
 * dialog is a separate surface and the photo behind it is not the subject.
 */
const NO_DRAG_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a',
  '[role="option"]',
  '[role="slider"]',
  '[contenteditable="true"]',
  '.kbmap',
  '.vslider',
  '.modal',
  '.tt',
  '.tabstrip',
].join(', ');

export interface RubberBand {
  /** Current offset, in px. `{0,0}` at rest. */
  offset: { x: number; y: number };
  /** True while a drag is in progress — the caller drops its CSS transition
   *  so the photo tracks the pointer instead of easing behind it. */
  dragging: boolean;
}

/** Damped displacement: linear at first, asymptotic after SOFT_LIMIT. */
function resist(d: number): number {
  const sign = d < 0 ? -1 : 1;
  const a = Math.abs(d);
  if (a <= SOFT_LIMIT) return d * 0.55;
  return sign * (SOFT_LIMIT * 0.55 + (a - SOFT_LIMIT) * 0.12);
}

export function useRubberBandDrag(enabled: boolean): RubberBand {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const from = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    // Never leave an offset behind when the feature switches off mid-gesture
    // (a tab change, say) — the photo would sit permanently askew.
    if (!enabled) {
      from.current = null;
      setDragging(false);
      setOffset({ x: 0, y: 0 });
      return;
    }
    // Respect a reduced-motion preference: no springy overshoot for someone
    // who has asked the OS for less of it.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const move = (ev: PointerEvent) => {
      const f = from.current;
      if (!f) return;
      const dx = ev.clientX - f.x;
      const dy = ev.clientY - f.y;
      if (!moved.current && Math.hypot(dx, dy) > CLICK_SLOP) {
        moved.current = true;
        setDragging(true);
      }
      if (moved.current) setOffset({ x: resist(dx), y: resist(dy) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      from.current = null;
      setDragging(false);
      setOffset({ x: 0, y: 0 });
      // A real drag must not also count as a click. Nothing here ever calls
      // `preventDefault` on the pointer events themselves — that is what keeps
      // every control underneath working — so the click that follows a drag
      // has to be swallowed instead, or tugging the photo while the pointer
      // happens to be over a device card would open that device.
      if (!moved.current) return;
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      // If no click follows (a pointercancel, or a release outside the
      // window), the one-shot listener would sit there and eat the NEXT one.
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      // Consumed. Without this the flag stayed true until the next press, and
      // the cleanup below — which calls `up()` when the feature switches off —
      // would arm a second swallow that ate an unrelated click.
      moved.current = false;
    };
    const down = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(NO_DRAG_SELECTOR)) return;
      from.current = { x: e.clientX, y: e.clientY };
      moved.current = false;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };

    window.addEventListener('pointerdown', down);
    return () => {
      window.removeEventListener('pointerdown', down);
      up();
    };
  }, [enabled]);

  return { offset, dragging };
}
