import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DeviceArt, resolveDeviceArt } from './DeviceArt';
import type { ArtRect } from './ArtAnchor';
import { getContentBox, fitContentBoxToTarget, type ContentBox } from './imageContentBox';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { useRubberBandDrag } from './useRubberBandDrag';

/**
 * The single travelling device image for the whole app. Rendered exactly
 * once, as a direct child of `.content` (see App.tsx) so it never unmounts
 * while any device config tab is open, and `position: fixed` so it floats
 * over whatever screen is showing.
 *
 * It chases `store.artTarget.rect` — the viewport box where the image should
 * sit right now, republished continuously by whichever <ArtAnchor> is
 * on-screen (a device tab's hero box, or that device's Home card). Because
 * this is the same DOM node throughout, moving between those boxes is a plain
 * CSS transition: card -> device and device -> card are the one animation run
 * in either direction.
 *
 * Two things keep it from getting stranded or stuttering:
 *
 *  - **It only paints on Home or its own device tab.** On Settings /
 *    Auto-Switch / another device's tab there is no anchor to report a box,
 *    so it would otherwise sit frozen at its last rect over an unrelated
 *    screen. Here it's `display:none` on those tabs instead (state kept, so
 *    it resumes cleanly).
 *  - **Transitions are off until it has painted at its start box.** A new
 *    flight is pinned to its launch rect (`artFlight.from`, the clicked
 *    card) with motion disabled for two frames; only then does it enable
 *    transitions and move to the target. Same dance when it reappears after
 *    a detour through another tab. Without this the browser paints just the
 *    destination and there's nothing to interpolate — the "we barely see one
 *    frame" bug this replaces.
 *
 * Once a Home-bound flight settles, the overlay hides (`artFlight.landed`,
 * lifted into the store — see setArtLanded) and the card's own inline
 * <DeviceArt> shows through again, so the card keeps its hover
 * lift/scale/glow. The card itself watches the same flag to hide its inline
 * art for the span this overlay is covering it (see DeviceGrid's Card) —
 * without that, both images are on screen for the whole return flight.
 * Clicking the card starts the next flight.
 *
 * `mode: 'interactive'` (the Buttons tab) is this same photo, never a second
 * local copy — it never fades or hides while on that tab, and the numbered
 * badges (`store.buttonBadges`, set by ButtonsTab) are drawn as children
 * right here, on top of it. Drawing them anywhere else — the Buttons tab's
 * own layout, say — would put them in a different part of the DOM tree than
 * this `position: fixed` image, and a plain z-index can't reliably win
 * across that boundary; drawing them as siblings of the `<img>` inside *this*
 * element sidesteps the question entirely.
 *
 * `mode: 'keyboard'` (the interactive key map) is genuinely different
 * artwork, so that one does fade — see `.is-hidden` in styles.css for why
 * that fade is delayed rather than starting immediately. Its target is also
 * a different *shape* than the photo: the anchor is KeyboardMap's own board
 * rectangle (see ArtAnchor's `measureRef`), and the photo carries a few
 * percent of transparent padding around the actual keyboard silhouette.
 * Naively `object-fit: contain`-ing the whole photo into that box let the
 * padding throw off the alignment between the photo's keyboard edge and the
 * board's — `imageContentBox.ts`'s `getContentBox`/`fitContentBoxToTarget`
 * map the photo's own non-transparent bounding box onto the target instead,
 * so it's the *keyboard in the photo* that lines up with the key grid, not
 * the image canvas. The same helper (with no cropping — a plain 0..1 box)
 * gets `mode: 'interactive'` the exact rendered sub-rect its badges need,
 * for the same reason: the anchor is square-ish and taller than the photo's
 * own aspect ratio, so `object-fit: contain` letterboxes it — badges have to
 * be placed against that letterboxed sub-rect, not the full anchor box.
 */
export function PersistentDeviceArt() {
  const flight = useStore((s) => s.artFlight);
  const target = useStore((s) => s.artTarget);
  const activeTabId = useStore((s) => s.activeTabId);
  const setArtLanded = useStore((s) => s.setArtLanded);
  const device = useStore((s) =>
    flight ? (s.devices.find((d) => d.id === flight.deviceId) ?? null) : null,
  );
  const colorPreview = useStore((s) => s.artColorPreview);
  const buttonBadges = useStore((s) => s.buttonBadges);
  const badgeActive = useStore((s) => s.buttonBadgeActive);
  const setBadgeActive = useStore((s) => s.setButtonBadgeActive);
  const t = useT();

  const [box, setBox] = useState<ArtRect | null>(null);
  const [animate, setAnimate] = useState(false);
  const rafRef = useRef(0);

  const onHome = activeTabId === 'home';
  const onOwnTab = !!flight && activeTabId === `device:${flight.deviceId}`;
  const onSurface = onHome || onOwnTab;
  const homeLanded = flight?.landed ?? false;

  // Identifies "a flight, on a surface, showing here" — changes only on a
  // genuinely new flight or a surface switch (Home <-> the device's own tab).
  // Everything the setup effect below needs to redo its dance is captured by
  // this one string turning into a *different* string, so it can be the
  // effect's only dependency: no hand-rolled prevKey/prevActive refs racing
  // against the effect's own state writes (see the note below on why that
  // used to break).
  const runKey = flight && onSurface ? `${flight.deviceId}|${activeTabId}` : null;
  // Read through a ref so the effect body always sees the latest flight
  // without needing it in the dependency array — `flight` changes identity
  // on every store update (e.g. setArtLanded below), which would otherwise
  // retrigger this effect for reasons unrelated to "is this a new flight".
  const flightRef = useRef(flight);
  flightRef.current = flight;
  const onHomeRef = useRef(onHome);
  onHomeRef.current = onHome;
  // Only reset to the launch box (`flight.from`) for a genuinely *new*
  // flight — a surface switch (e.g. Ctrl+Tab away and back) on the same
  // flight should resume wherever it last landed, not jump back to the
  // originating card. Local to this effect's own decisions, so — unlike the
  // old prevKey/prevActive pair — nothing outside ever races it.
  const prevDeviceId = useRef<string | null>(null);

  // Settle at the start box (transitions off), then enable them a couple of
  // frames later. Fires on a brand-new flight and whenever the image
  // reappears on a surface after a detour through another tab — i.e.
  // whenever `runKey` actually changes, which now includes React's own
  // StrictMode double-invoke (idempotent: rerunning with the same key is a
  // no-op via the `!runKey` guard below since there's nothing new to settle).
  useLayoutEffect(() => {
    if (!runKey) {
      setBox(null);
      setAnimate(false);
      prevDeviceId.current = null;
      return;
    }
    const f = flightRef.current!;
    const newFlight = prevDeviceId.current !== f.deviceId;
    prevDeviceId.current = f.deviceId;
    setArtLanded(f.deviceId, false);
    setAnimate(false);
    if (newFlight && f.from) setBox(f.from);
    const r1 = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => setAnimate(true));
    });
    // Backstop for `onTransitionEnd` — if the fly-home move happens not to
    // change `top` (or the event is missed), still hand back to the card's
    // own inline art so it isn't covered forever.
    const land = onHomeRef.current
      ? window.setTimeout(() => setArtLanded(f.deviceId, true), 750)
      : undefined;
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(rafRef.current);
      if (land) window.clearTimeout(land);
    };
  }, [runKey, setArtLanded]);

  // Chase the reported target — but not before transitions are live, or the
  // move would snap instead of glide. Re-runs when `animate` flips true.
  useLayoutEffect(() => {
    if (!flight || !target || target.deviceId !== flight.deviceId) return;
    if (!onSurface || !animate) return;
    setBox(target.rect);
  }, [flight, target, animate, onSurface]);

  const mode = target?.mode ?? flight?.mode ?? 'hero';

  const visible = !!flight && !!device && !!box && onSurface && !(onHome && homeLanded);

  // Both `mode: 'keyboard'` (crop to the photo's own silhouette) and
  // `mode: 'interactive'` (plain contain, just to find the letterboxed
  // sub-rect for badge placement) need the image's aspect ratio; only
  // 'keyboard' needs the actual crop. See the class doc comment above.
  // The colourway being hovered in a picker wins over the saved one, so the
  // hero photo previews a colour before it is chosen (see `artColorPreview`).
  // Scoped to the device whose picker is being hovered — two device tabs can
  // be open at once.
  const colorVariant =
    device && colorPreview?.deviceId === device.id
      ? colorPreview.variant
      : (device?.colorVariant ?? null);
  const resolvedSrc = device ? resolveDeviceArt(device.model, colorVariant, device.art) : null;
  const [contentBox, setContentBox] = useState<ContentBox | null>(null);
  useEffect(() => {
    if (!resolvedSrc || (mode !== 'keyboard' && mode !== 'interactive')) {
      setContentBox(null);
      return;
    }
    let cancelled = false;
    getContentBox(resolvedSrc).then((b) => {
      if (!cancelled) setContentBox(b);
    });
    return () => {
      cancelled = true;
    };
  }, [mode, resolvedSrc]);

  const fitted =
    mode === 'keyboard' && contentBox && box ? fitContentBoxToTarget(contentBox, box) : null;
  const badgeArea =
    mode === 'interactive' && contentBox && box
      ? fitContentBoxToTarget({ x0: 0, y0: 0, x1: 1, y1: 1, aspect: contentBox.aspect }, box)
      : null;
  const badges = mode === 'interactive' && device ? (buttonBadges[device.id] ?? null) : null;

  /**
   * Tugging the photo pulls it a little and springs it back. The gesture is
   * bound to `window`, not to this element — see useRubberBandDrag — so the
   * overlay stays `pointer-events: none` in every state and a press anywhere
   * on the interface tugs the photo.
   *
   * Still deliberately narrow about when it is armed:
   *  - `!animate` — a flight is still settling and the box is moving out from
   *    under the gesture;
   *  - `interactive` (Buttons) — the numbered badges are drawn on the photo
   *    and a drag there is aimed at them;
   *  - `keyboard` (Keys / Actuation / per-key Lighting) — the photo is faded
   *    out ON TOP of the interactive key map, so tugging an invisible
   *    rectangle over the board would read as the board itself sliding.
   */
  const artRef = useRef<HTMLDivElement>(null);
  const draggable = visible && animate && mode !== 'interactive' && mode !== 'keyboard';
  const rubber = useRubberBandDrag(draggable);

  return (
    <div
      className={[
        'device-art-persistent',
        !visible ? 'is-gone' : '',
        // Only 'keyboard' fades — a genuinely different surface underneath
        // (the interactive key map). 'interactive' is the same photo the
        // whole time, so it never fades or hides at all.
        mode === 'keyboard' ? 'is-hidden' : '',
        !animate ? 'no-transition' : '',
        fitted ? 'is-fitted' : '',
        rubber.dragging ? 'is-dragging' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      ref={artRef}
      style={
        box
          ? {
              top: box.top,
              left: box.left,
              width: box.width,
              height: box.height,
              // A TRANSFORM, never the box itself: top/left/width/height are
              // the flight system's, and writing to them here would fight it.
              // At rest this is `translate(0,0)`, so it costs nothing.
              transform:
                rubber.offset.x || rubber.offset.y
                  ? `translate(${rubber.offset.x}px, ${rubber.offset.y}px)`
                  : undefined,
            }
          : undefined
      }
      onTransitionEnd={(e) => {
        if (e.propertyName !== 'top' && e.propertyName !== 'left') return;
        if (onHome && flight) setArtLanded(flight.deviceId, true);
      }}
    >
      {device && fitted && resolvedSrc && (
        <img
          src={resolvedSrc}
          alt=""
          style={{
            position: 'absolute',
            left: fitted.left,
            top: fitted.top,
            width: fitted.width,
            height: fitted.height,
            maxWidth: 'none',
            maxHeight: 'none',
          }}
        />
      )}
      {device && !fitted && (
        <DeviceArt
          kind={device.kind}
          art={device.art}
          model={device.model}
          colorVariant={colorVariant}
          layout={device.ui.keyMatrix?.layout}
        />
      )}
      {badges &&
        badgeArea &&
        badges.map((e) => {
          const label = e.labelKey ? t(e.labelKey as never) : e.label;
          const tip = e.notVisibleInPhoto ? `${label} — ${t('buttons.notVisible')}` : label;
          return (
            // A plain `title` attribute, not <Tooltip> — that component
            // measures its own wrapping span to place the floating bubble,
            // which only works for a wrapper sitting in normal flow. These
            // badges are `position: absolute` (placed against the photo's
            // own letterboxed sub-rect, computed above), so the wrapper
            // would've stayed put at wherever it fell in flow while the
            // button itself moved away — the bubble would show up at the
            // wrong spot entirely.
            <button
              key={e.index}
              type="button"
              title={tip}
              className={`mbp-badge ${badgeActive === e.index ? 'is-active' : ''} ${e.notVisibleInPhoto ? 'mbp-badge-inferred' : ''}`}
              style={{
                position: 'absolute',
                left: badgeArea.left + (e.x / 100) * badgeArea.width,
                top: badgeArea.top + (e.y / 100) * badgeArea.height,
              }}
              onMouseEnter={() => setBadgeActive(e.index)}
              onMouseLeave={() => setBadgeActive(null)}
            >
              {e.index + 1}
            </button>
          );
        })}
    </div>
  );
}
