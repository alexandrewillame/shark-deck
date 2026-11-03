import { useEffect, useMemo, useRef } from 'react';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { emittedCss } from '../../colorUtil';
import { effectColor, type PreviewBounds } from './effectPreview';

/**
 * One effect's animated thumbnail — the whole keyboard, or the side strip.
 *
 * ## Why a canvas
 *
 * The picker tiles used to be an abstract 6x3 grid of `<span>`s: eighteen
 * cells that stood for a keyboard without looking like one, so a wave across
 * six columns and a wave across seventy-nine keys were different pictures and
 * only one of them was the one you were choosing. Drawing the REAL layout in
 * DOM is what the grid was avoiding — twenty tiles times seventy-nine keys is
 * ~1600 nodes with an inline style each, reconciled twenty times a second.
 *
 * A canvas has no such cost: the same 1600 fills are a few hundred
 * microseconds of `fillRect`, and React reconciles one element per tile. The
 * draw happens in an effect keyed on the phase, so nothing above it re-renders
 * either.
 *
 * ## Why it is flat
 *
 * No glow, no cap moulding, no legends — at four pixels per key those are
 * mud. This is the same call `.kbmap-bare` makes for the saved-preset
 * thumbnails in keyboard-map.css: at thumbnail size the key IS the colour,
 * because a tinted cap would make every tile the same grey. The big preview
 * board above is the photograph; these are the diagram.
 */

/** How wide the canvas is drawn, in device-independent pixels. Fixed rather
 *  than measured: the tile is never more than ~120px on screen, so this is
 *  already 2x, and a ResizeObserver per tile would cost more than it saves. */
const CANVAS_W = 240;

/** One shared empty layout, so a tile with no board does not get a fresh array
 *  identity on every frame and redraw for nothing. */
const NO_KEYS: readonly KeyLayoutEntry[] = [];

/** Bounds of a layout in key units — `maxX` is the far edge of the widest
 *  row, so a board ending in a 2u key is not cut in half. */
function extent(layout: readonly KeyLayoutEntry[]): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const k of layout) {
    w = Math.max(w, k.x + (k.w ?? 1));
    h = Math.max(h, k.y + (k.h ?? 1));
  }
  return { w: w || 1, h: h || 1 };
}

/** The bounds an effect is evaluated against: the LAST key's origin, not the
 *  board's far edge, matching `nx`/`ny` in effectPreview.ts. */
function previewBounds(layout: readonly KeyLayoutEntry[]): PreviewBounds {
  let maxX = 0;
  let maxY = 0;
  for (const k of layout) {
    maxX = Math.max(maxX, k.x);
    maxY = Math.max(maxY, k.y);
  }
  return { maxX, maxY };
}

export function EffectThumb({
  label,
  layout,
  phase,
  color,
  rainbow,
  option,
  strip,
}: {
  label: string;
  /** The device's own key layout. Without it the tile draws the strip form,
   *  which needs no layout — better than inventing a keyboard shape. */
  layout?: readonly KeyLayoutEntry[];
  phase: number;
  color: [number, number, number];
  rainbow: boolean;
  option?: number;
  /**
   * Draw one continuous bar instead of a board.
   *
   * The side lighting IS one long diffused LED strip across the front of the
   * case, so drawing its effects as rows of little rectangles said the wrong
   * thing about the hardware — it looked like a second keyboard.
   */
  strip?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const keys = layout ?? NO_KEYS;
  const flat = strip || !keys.length;
  // Measured once per layout, not once per frame: this runs for every tile on
  // every tick of the picker's phase.
  const box = useMemo(() => (flat ? { w: 18, h: 6 } : extent(keys)), [flat, keys]);
  const bounds = useMemo(() => previewBounds(keys), [keys]);
  const height = Math.round((CANVAS_W * box.h) / box.w);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no 2D context, and a browser can refuse one under memory
    // pressure. Neither is a reason to throw out of a render.
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = el.getContext('2d');
    } catch {
      ctx = null;
    }
    if (!ctx) return;
    const w = el.width;
    const h = el.height;
    // Cleared, not filled: the plate is `--kbmap-lit-bg` on the element's own
    // CSS background, so it follows the theme with the big board rather than
    // being a black rectangle baked into the bitmap. A canvas cannot read a
    // custom property, and reading one back per tile per frame to paint it
    // here would be the same colour arrived at the expensive way.
    ctx.clearRect(0, 0, w, h);

    if (flat) {
      // One bar, sampled along its length: the strip is a single diffused
      // extrusion, so the picture is a gradient and not a row of cells.
      const steps = 48;
      const grad = ctx.createLinearGradient(0, 0, w, 0);
      for (let i = 0; i < steps; i++) {
        const t = i / (steps - 1);
        grad.addColorStop(
          t,
          emittedCss(
            effectColor(
              label,
              { x: t * (steps - 1), y: 0 },
              {
                phase,
                bounds: { maxX: steps - 1, maxY: 0 },
                color,
                brightness: 100,
                rainbow,
                option,
                // Which RENDERER to use, not only which shape to draw in: some
                // effects look nothing alike on a bar. See STRIP_RENDERERS.
                strip: true,
              },
            ),
          ),
        );
      }
      const barH = Math.max(6, h * 0.3);
      const pad = w * 0.03;
      ctx.fillStyle = grad;
      roundRect(ctx, pad, (h - barH) / 2, w - pad * 2, barH, barH / 2);
      ctx.fill();
      return;
    }

    const u = w / box.w;
    const gap = Math.max(0.8, u * 0.13);
    const r = Math.min(2.5, u * 0.16);
    for (const k of keys) {
      // Through `emittedCss` for the same reason the big board is: a raw
      // `#0000ff` tile reads as violet, and a blue keyboard does not.
      ctx.fillStyle = emittedCss(
        effectColor(label, k, { phase, bounds, color, brightness: 100, rainbow, option }),
      );
      roundRect(
        ctx,
        k.x * u + gap / 2,
        k.y * u + gap / 2,
        (k.w ?? 1) * u - gap,
        (k.h ?? 1) * u - gap,
        r,
      );
      ctx.fill();
    }
  }, [label, keys, phase, color, rainbow, option, flat, box.w, bounds]);

  return (
    <canvas
      ref={ref}
      className="effect-thumb"
      width={CANVAS_W}
      height={height}
      aria-hidden="true"
      style={{ aspectRatio: `${CANVAS_W} / ${height}` }}
    />
  );
}

/** `ctx.roundRect` with a fallback: it is a recent addition and the path is
 *  worth having even where it is missing. */
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
