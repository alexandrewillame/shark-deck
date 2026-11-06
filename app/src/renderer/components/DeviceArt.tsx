import { useId } from 'react';
import { ANSI_75 } from '../keyLayout';
import { GAP_U, bakedGapOf } from './KeyboardMap';
import type { KeyLayoutEntry } from '@shared/types/keys';
import type { DeviceKind } from '@shared/types/device';
import { DEVICE_ART } from './deviceArtAssets';

/**
 * The same "colour variant, then the descriptor's plain `art`, then nothing"
 * lookup `DeviceArt` uses to decide whether it has a real photo at all —
 * factored out so `PersistentDeviceArt` can resolve the exact same image URL
 * (to feed `imageContentBox.ts`'s aspect-ratio/crop detection) without
 * duplicating the variant table lookup.
 */
export function resolveDeviceArt(
  artKey: string | undefined,
  colorVariant: string | null | undefined,
  art: string | null,
): string | null {
  const variantArt = artKey && colorVariant ? DEVICE_ART[artKey]?.[colorVariant] : undefined;
  return variantArt ?? art;
}

/**
 * Generated SVG silhouettes per form factor, with real product photos on
 * top when available: `colorVariant` resolves through `DEVICE_ART`; failing
 * that, the legacy single-image `art` field on the descriptor; failing that,
 * the generated silhouette below. Colours in the generated silhouettes are
 * theme tokens.
 *
 * `colorVariant` is the user's cosmetic colour/edition pick (see
 * ColorPicker.tsx) but is never null for a model that has any — devices/
 * manager.ts defaults it to the catalogue's first variant on attach, so the
 * silhouette is reserved for models that genuinely ship no art.
 *
 * Gradient ids are per-instance (`useId()`) rather than the literal `"g"`/
 * `"gm"` they used to be — these are inline, un-isolated SVGs, so rendering
 * more than one card at once (the whole point of DeviceGrid) produced
 * duplicate DOM ids; `url(#g)` could then resolve to the wrong (possibly
 * removed/stale) node after React reconciliation reordered cards, which is
 * one plausible way an outline could silently disappear.
 */
export function DeviceArt({
  kind,
  art,
  artKey,
  colorVariant,
  layout,
}: {
  kind: DeviceKind;
  art: string | null;
  /** `DeviceUi.artKey` — resolves a colour variant photo via deviceArtAssets.ts */
  artKey?: string;
  /** LiveDevice.colorVariant */
  colorVariant?: string | null;
  /** `LiveDevice.ui.keyMatrix.layout`. The generated keyboard silhouette is
   *  drawn from the REAL board when one is known — see KeyboardSilhouette. */
  layout?: KeyLayoutEntry[];
}) {
  const uid = useId();
  const gid = `dvart-${uid}`;

  const resolvedArt = resolveDeviceArt(artKey, colorVariant, art);
  // Sizing is left entirely to the parent's CSS (`.card .art img`, `.ov-art
  // img`, …) via `object-fit: contain` — an inline max-height/max-width here
  // used to win over those rules by specificity and, worse, silently failed
  // to resolve at all inside a `place-items: center` grid cell (the photo's
  // native aspect ratio would blow out the box's fixed height and get
  // clipped by the parent's `overflow: hidden`). See styles.css.
  //
  // `draggable={false}`: a plain `<img>` is draggable by default in
  // Chromium, so a card drag gesture that starts on the photo used the
  // browser's own auto-generated ghost (just the image) instead of the
  // whole `.card` — `dragstart` still bubbled up so the reorder logic
  // itself worked, but only the photo visibly moved. This opts the image
  // out so `Card`'s own `onDragStart` (DeviceGrid.tsx) is what supplies the
  // drag image.
  if (resolvedArt) return <img src={resolvedArt} alt="" draggable={false} />;

  if (kind === 'keyboard') {
    return <KeyboardSilhouette layout={layout} gradientId={gid} />;
  }

  if (kind === 'mouse') {
    return (
      <svg viewBox={MOUSE_SILHOUETTE_VIEWBOX} fill="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="var(--accent)" />
            <stop offset="1" stopColor="var(--violet)" />
          </linearGradient>
        </defs>
        <MouseSilhouettePaths strokeUrl={`url(#${gid})`} />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 120 120" fill="none">
      <rect
        x="34"
        y="20"
        width="52"
        height="80"
        rx="10"
        fill="var(--bg-2)"
        stroke="var(--accent)"
        strokeWidth="2"
      />
      <rect x="52" y="8" width="16" height="18" rx="3" fill="var(--bg-3)" />
    </svg>
  );
}

/**
 * A keyboard drawn from the board's OWN layout, not a grid of identical
 * squares.
 *
 * The preview used to be a hardcoded 5 x 14 of equal rects: no F-row gap, no
 * wide modifiers, no arrow cluster, no nav block — every keyboard in the grid
 * looked like the same generic slab. The real geometry is already in
 * `KeyLayoutEntry.x/y/w`, and the interactive board renders from exactly that,
 * so this shares its gutter maths (`GAP_U`, `bakedGapOf`) and comes out as a
 * small version of the same picture rather than a second idea of a keyboard.
 *
 * `U` is arbitrary — it only sets the viewBox's internal scale, since the SVG
 * is sized by the card's CSS.
 */
function KeyboardSilhouette({
  layout,
  gradientId,
}: {
  layout?: KeyLayoutEntry[];
  gradientId: string;
}) {
  const keys = layout && layout.length ? layout : ANSI_75;
  const U = 10;
  const PAD = 7;
  /** The case's corner radius, in the same units: 0.4 of a key, ~5-6px on a card. */
  const CASE_R = 4;
  const baked = bakedGapOf(keys);
  const gap = Math.max(0, (GAP_U - baked) * U);
  const vgap = GAP_U * U;
  const keyH = (1 - GAP_U) * U;

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const k of keys) {
    if (k.x < xMin) xMin = k.x;
    if (k.x + (k.w ?? 1) + baked > xMax) xMax = k.x + (k.w ?? 1) + baked;
    if (k.y < yMin) yMin = k.y;
    if (k.y + 1 > yMax) yMax = k.y + 1;
  }
  const w = (xMax - xMin) * U + PAD * 2;
  const h = (yMax - yMin) * U + PAD * 2;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} fill="none">
      {/* A small radius: a milled case with its edges eased, not a block.
          Kept well short of a mouse's rounded shell — the old fully rounded
          slab read as the same object as the mouse card beside it — and well
          past the keycaps' own 1.6, so the case still reads as the thing the
          keys sit in. (Any rx up to ~6 clears the corner keys: they start at
          PAD + gap / 2 from the edge.) */}
      <rect
        x={1}
        y={1}
        width={w - 2}
        height={h - 2}
        rx={CASE_R}
        fill="var(--bg-2)"
        stroke={`url(#${gradientId})`}
        strokeWidth={2}
      />
      {keys.map((k) => (
        <rect
          key={`${k.row}-${k.col}`}
          x={(k.x - xMin) * U + PAD + gap / 2}
          y={(k.y - yMin) * U + PAD + vgap / 2}
          width={Math.max(1, (k.w ?? 1) * U - gap)}
          height={keyH}
          rx={1.6}
          fill="var(--kbkey-bg)"
        />
      ))}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--violet)" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** Shared with `MouseButtonDiagram.tsx` (the numbered click-the-button
 *  picker on the Buttons tab) so the two can never visually drift apart —
 *  `ButtonMapEntry.x/y` percentages are defined against this exact viewBox. */
export const MOUSE_SILHOUETTE_VIEWBOX = '0 0 130 176';

/**
 * The mouse shell, in the outline a gaming mouse actually has: narrow at the
 * front, widest across the rear third, a gentle waist between — the Superlight
 * silhouette rather than the plain oval this used to be.
 *
 * Only the features that make it read as a mouse are drawn: the shell, the
 * seam across the front of the click buttons, the split between them, and the
 * wheel. The old version also drew two side-button rects, a thumb-scoop arc
 * and a DPI-LED dot with a bar under it — every one of them a literal part
 * rendered at a size where it could only be a smudge, and the split ran PAST
 * the button seam instead of stopping at it. The graphical button picker
 * positions its own numbered bubbles over this shape, so removing the drawn
 * buttons costs nothing.
 *
 * `MOUSE_SILHOUETTE_VIEWBOX` must not change: `ButtonMapEntry.x/y` are
 * percentages of it, so every bubble would move.
 */
export function MouseSilhouettePaths({ strokeUrl }: { strokeUrl: string }) {
  return (
    <>
      {/*
        Shell, TRACED off Logitech's own dimension drawing for the PRO X
        Superlight 2 — not drawn from a description of one.

        The trace walks OUTWARD from a row two thirds down the body, keeping
        its search window only a little wider than the previous row. That
        matters: a fixed window either reaches the sheet's callout text (which
        drags the outline sideways) or, if narrowed to avoid it, has to start
        at a row that is already wide — which cuts the nose and tail domes off
        and leaves flat ends with a corner where they meet the sides.

        The result is 0.511 wide for its length against the real 63.5/125 =
        0.508. Nodes are resampled to an even spacing and fitted with a
        CENTRIPETAL Catmull-Rom: the uniform form overshoots where a short
        segment meets a long one, which put a control point above its own start
        node and left a visible kink on the shoulder.

        What the trace settled, against several hand-drawn attempts: this mouse
        is not a teardrop. It reaches ~95% of full width by a fifth of its
        length and holds it to about 80%, widest around two thirds back.
      */}
      {/* Fill first, detail lines second, CONTOUR LAST.
          The body used to be drawn filled AND stroked in one pass, with the
          button lines after it — so where a 1.5px seam met the 2.5px contour
          it painted over it, and the shell looked nicked at four points. The
          outline is the silhouette; nothing inside the shell should cross it.
          It cannot simply be reordered either: the detail lines drawn first
          would be hidden under the body's own fill. */}
      <path
        d="M65 6C68.5 6 72.1 6.7 75.6 7.5C79 8.2 82.5 9.3 85.7 10.7C88.9 12.1 92.3 13.7 94.9 15.9C97.5 18.2 99.8 21.1 101.5 24.1C103.1 27 104.2 30.5 104.8 33.9C105.5 37.3 105.3 41 105.4 44.5C105.4 48 105.1 51.6 105 55.1C104.9 58.7 104.8 62.2 104.7 65.8C104.6 69.3 104.4 72.9 104.3 76.4C104.2 80 103.9 83.5 104 87.1C104 90.6 104.2 94.2 104.4 97.7C104.7 101.2 105.2 104.7 105.6 108.3C105.9 111.8 106.2 115.4 106.3 118.9C106.4 122.5 106.5 126 106.1 129.6C105.8 133.1 105.3 136.6 104.3 140C103.3 143.4 102 146.8 100.2 149.8C98.5 152.8 96.3 155.6 93.8 158.1C91.3 160.5 88.4 162.8 85.3 164.5C82.3 166.3 78.9 167.7 75.5 168.7C72.1 169.6 68.5 170 65 170C61.5 170 57.9 169.6 54.5 168.7C51.1 167.7 47.7 166.3 44.7 164.5C41.6 162.8 38.7 160.5 36.2 158.1C33.7 155.6 31.5 152.8 29.8 149.8C28 146.8 26.7 143.4 25.7 140C24.7 136.6 24.2 133.1 23.9 129.6C23.5 126 23.6 122.5 23.7 118.9C23.8 115.4 24.1 111.8 24.4 108.3C24.8 104.7 25.3 101.2 25.6 97.7C25.8 94.2 26 90.6 26 87.1C26.1 83.5 25.8 80 25.7 76.4C25.6 72.9 25.4 69.3 25.3 65.8C25.2 62.2 25.1 58.7 25 55.1C24.9 51.6 24.6 48 24.6 44.5C24.7 41 24.5 37.3 25.2 33.9C25.8 30.5 26.9 27 28.5 24.1C30.2 21.1 32.5 18.2 35.1 15.9C37.7 13.7 41.1 12.1 44.3 10.7C47.5 9.3 51 8.2 54.4 7.5C57.9 6.7 61.5 6 65 6Z"
        fill="var(--bg-2)"
      />
      {/* seam across the back of the two click buttons, at ~47% of the length */}
      <path d="M25.6 79C40 91 90 91 104.4 79" stroke="var(--line)" strokeWidth="1.5" fill="none" />
      {/* the split between them — stops ON the seam, which passes through
          x=65 at y=88, rather than carrying on down the shell */}
      <path d="M65 7v81" stroke="var(--line)" strokeWidth="1.5" />
      {/* scroll wheel */}
      <rect
        x="59.5"
        y="18"
        width="11"
        height="28"
        rx="5.5"
        fill="var(--bg-3)"
        stroke={strokeUrl}
        strokeWidth="1.5"
      />
      <path
        d="M65 6C68.5 6 72.1 6.7 75.6 7.5C79 8.2 82.5 9.3 85.7 10.7C88.9 12.1 92.3 13.7 94.9 15.9C97.5 18.2 99.8 21.1 101.5 24.1C103.1 27 104.2 30.5 104.8 33.9C105.5 37.3 105.3 41 105.4 44.5C105.4 48 105.1 51.6 105 55.1C104.9 58.7 104.8 62.2 104.7 65.8C104.6 69.3 104.4 72.9 104.3 76.4C104.2 80 103.9 83.5 104 87.1C104 90.6 104.2 94.2 104.4 97.7C104.7 101.2 105.2 104.7 105.6 108.3C105.9 111.8 106.2 115.4 106.3 118.9C106.4 122.5 106.5 126 106.1 129.6C105.8 133.1 105.3 136.6 104.3 140C103.3 143.4 102 146.8 100.2 149.8C98.5 152.8 96.3 155.6 93.8 158.1C91.3 160.5 88.4 162.8 85.3 164.5C82.3 166.3 78.9 167.7 75.5 168.7C72.1 169.6 68.5 170 65 170C61.5 170 57.9 169.6 54.5 168.7C51.1 167.7 47.7 166.3 44.7 164.5C41.6 162.8 38.7 160.5 36.2 158.1C33.7 155.6 31.5 152.8 29.8 149.8C28 146.8 26.7 143.4 25.7 140C24.7 136.6 24.2 133.1 23.9 129.6C23.5 126 23.6 122.5 23.7 118.9C23.8 115.4 24.1 111.8 24.4 108.3C24.8 104.7 25.3 101.2 25.6 97.7C25.8 94.2 26 90.6 26 87.1C26.1 83.5 25.8 80 25.7 76.4C25.6 72.9 25.4 69.3 25.3 65.8C25.2 62.2 25.1 58.7 25 55.1C24.9 51.6 24.6 48 24.6 44.5C24.7 41 24.5 37.3 25.2 33.9C25.8 30.5 26.9 27 28.5 24.1C30.2 21.1 32.5 18.2 35.1 15.9C37.7 13.7 41.1 12.1 44.3 10.7C47.5 9.3 51 8.2 54.4 7.5C57.9 6.7 61.5 6 65 6Z"
        fill="none"
        stroke={strokeUrl}
        strokeWidth="2.5"
      />
    </>
  );
}
