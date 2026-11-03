import { useLayoutEffect, useState, type RefObject } from 'react';

/**
 * Shared positioning logic for anything rendered through a `document.body`
 * portal at `position: fixed` — extracted from `Tooltip` (see common.tsx),
 * which needed this specifically because an absolutely-positioned-in-place
 * bubble gets clipped by an ancestor's `overflow: hidden` (any card, `.pane`,
 * `.content`) or trapped inside an ancestor's CSS stacking context (e.g.
 * `.topbar`'s `backdrop-filter`, which is what hid the language menu behind
 * device cards despite its own `z-index`). Anything with the same shape —
 * a trigger element and a floating panel that must never clip or get
 * covered — should portal to `document.body` and use this hook instead of
 * `position: absolute` inside its own DOM position.
 */

/** Above or below the anchor — or beside it, for a panel next to a list
 *  (a listbox option's explanation), where above or below would cover the
 *  very options being compared. */
export type AnchoredPlacement = 'top' | 'bottom' | 'left' | 'right';

export interface AnchoredPosition {
  left: number;
  top: number;
  placement: AnchoredPlacement;
  /**
   * The tallest the panel may be and still fit on screen, measured from where
   * it is about to be placed.
   *
   * A CSS `max-height` can only guess at this — it has no idea how much room is
   * left below the anchor — so a panel tall enough to matter either overflowed
   * the window or had to be capped so conservatively that it scrolled when it
   * did not need to. The caller applies this as an inline `maxHeight`; with
   * `overflow-y`, the panel then always fits and always scrolls exactly when
   * there is more inside it.
   */
  maxHeight: number;
}

export interface UseAnchoredPositionOptions {
  /** gap between the anchor and the floating panel */
  gap?: number;
  /** min gap kept between the panel and the viewport edge */
  margin?: number;
  /** alignment along the anchor's edge: horizontal above/below, vertical beside */
  align?: 'center' | 'start' | 'end';
  /** 'auto' mirrors Tooltip's original behaviour: prefer above when it fits,
   *  else below. 'left'/'right' sit beside the anchor, and swap sides when
   *  the one asked for has no room. */
  placement?: 'auto' | AnchoredPlacement;
}

export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  bubbleRef: RefObject<HTMLElement | null>,
  active: boolean,
  opts: UseAnchoredPositionOptions = {},
): AnchoredPosition | null {
  const { gap = 8, margin = 8, align = 'center', placement = 'auto' } = opts;
  const [pos, setPos] = useState<AnchoredPosition | null>(null);

  // Placed after the panel mounts (so its real size is known), then
  // re-placed on scroll/resize while active.
  useLayoutEffect(() => {
    if (!active) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      setPos(
        placeAnchored({
          anchor: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width },
          bubble: {
            width: bubbleRef.current?.offsetWidth ?? 240,
            height: bubbleRef.current?.offsetHeight ?? 40,
          },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          gap,
          margin,
          align,
          placement,
        }),
      );
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    // The panel's own height is not a window event: it changes when its content
    // does, and the cap above is computed from it.
    const ro =
      typeof ResizeObserver === 'undefined' || !bubbleRef.current
        ? null
        : new ResizeObserver(() => place());
    if (ro && bubbleRef.current) ro.observe(bubbleRef.current);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return pos;
}

/** The smallest a floating panel may be squeezed to before scrolling it is
 *  worse than letting it run off — a hard floor on `maxHeight`. */
export const MIN_PANEL_HEIGHT = 120;

export interface PlaceAnchoredInput {
  anchor: { top: number; bottom: number; left: number; right: number; width: number };
  bubble: { width: number; height: number };
  viewport: { width: number; height: number };
  gap: number;
  margin: number;
  align: 'center' | 'start' | 'end';
  placement: AnchoredPlacement | 'auto';
}

/**
 * Where a floating panel goes, and how tall it may be.
 *
 * Pure, and separated from the hook on purpose: every popover in the app goes
 * through it — tooltips, the language menu, the colour picker, the All-keys
 * menu — so the arithmetic is worth pinning with tests rather than checking by
 * opening each one.
 *
 * `maxHeight` is the part that cannot be done in CSS. A stylesheet can only
 * guess at a viewport fraction; it has no idea how much room is left below the
 * button, so a panel taller than that room either ran off the bottom of the
 * window with no way to reach it or had to be capped so conservatively that it
 * scrolled when it did not need to.
 */
export function placeAnchored({
  anchor,
  bubble,
  viewport,
  gap,
  margin,
  align,
  placement,
}: PlaceAnchoredInput): AnchoredPosition {
  if (placement === 'left' || placement === 'right') {
    return placeBeside({ anchor, bubble, viewport, gap, margin, align, placement });
  }

  let top: number;
  let resolved: AnchoredPlacement;
  let room: number;

  if (placement === 'top' || (placement === 'auto' && anchor.top >= bubble.height + gap + margin)) {
    resolved = 'top';
    room = anchor.top - gap - margin;
    top = anchor.top - gap - Math.min(bubble.height, room);
  } else {
    resolved = 'bottom';
    // Prefer sitting directly under the anchor; if the panel is taller than the
    // room left there, slide it up as far as the top margin allows and give it
    // whatever height that leaves.
    const below = viewport.height - (anchor.bottom + gap) - margin;
    if (bubble.height <= below) {
      top = anchor.bottom + gap;
      room = below;
    } else {
      top = Math.max(margin, viewport.height - margin - bubble.height);
      room = viewport.height - margin - top;
    }
  }

  let left: number;
  if (align === 'start') left = anchor.left;
  else if (align === 'end') left = anchor.right - bubble.width;
  else left = anchor.left + anchor.width / 2 - bubble.width / 2;
  left = Math.max(margin, Math.min(left, viewport.width - bubble.width - margin));

  const finalTop = Math.max(margin, top);
  return {
    left,
    top: finalTop,
    placement: resolved,
    maxHeight: Math.max(MIN_PANEL_HEIGHT, Math.min(room, viewport.height - margin - finalTop)),
  };
}

/**
 * `placeAnchored` for a panel beside its anchor: the side asked for, or the
 * other one when it would run off the window, aligned along the anchor's
 * height (`start` = tops level) and kept inside the window.
 */
function placeBeside({
  anchor,
  bubble,
  viewport,
  gap,
  margin,
  align,
  placement,
}: PlaceAnchoredInput & { placement: 'left' | 'right' }): AnchoredPosition {
  const rightLeft = anchor.right + gap;
  const leftLeft = anchor.left - gap - bubble.width;
  const fitsRight = rightLeft + bubble.width <= viewport.width - margin;
  const fitsLeft = leftLeft >= margin;
  const side: 'left' | 'right' =
    placement === 'right'
      ? fitsRight || !fitsLeft
        ? 'right'
        : 'left'
      : fitsLeft || !fitsRight
        ? 'left'
        : 'right';
  const left = Math.max(
    margin,
    Math.min(side === 'right' ? rightLeft : leftLeft, viewport.width - bubble.width - margin),
  );

  const anchorH = anchor.bottom - anchor.top;
  let top =
    align === 'start'
      ? anchor.top
      : align === 'end'
        ? anchor.bottom - bubble.height
        : anchor.top + anchorH / 2 - bubble.height / 2;
  top = Math.max(margin, Math.min(top, viewport.height - margin - bubble.height));
  return {
    left,
    top,
    placement: side,
    maxHeight: Math.max(MIN_PANEL_HEIGHT, viewport.height - margin - top),
  };
}
