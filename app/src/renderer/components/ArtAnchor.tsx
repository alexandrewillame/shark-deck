import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { useStore } from '../state/store';

export interface ArtRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * 'hero' — a tab that just wants the device photo sitting somewhere in its
 * layout (Profile, Macros, Device, and Lighting's non-keyboard panes).
 * 'keyboard' — wraps an actual interactive <KeyboardMap>, which paints its
 * own surface; PersistentDeviceArt fades itself out here instead of sitting
 * on top of it. 'interactive' — the Buttons tab: still the travelling photo
 * (never hidden — it's the *only* mouse photo, badges are drawn directly on
 * it by PersistentDeviceArt, see its own doc comment), just a taller anchor
 * box so the badges have room. This anchor itself renders no content of its
 * own in either 'keyboard' or 'hero' + 'interactive' cases — it only marks
 * where the travelling photo, or a caller's own <KeyboardMap>, belongs.
 */
export type ArtMode = 'hero' | 'keyboard' | 'interactive';

export const ArtAnchorContext = createContext<((rect: ArtRect, mode: ArtMode) => void) | null>(
  null,
);

/** Every live <ArtAnchor> re-measures when this fires. */
const RELAYOUT_EVENT = 'sharkdeck:relayout';

/**
 * Tell the anchors that something moved them without resizing them.
 *
 * `ResizeObserver` sees a box change shape, `scroll` and `resize` see the
 * viewport change — nothing sees an element that is the same size, in the same
 * scroll position, simply somewhere else. Collapsing the tab rail is exactly
 * that: `.pane.hero-side`'s art column keeps its width, so the travelling photo
 * kept its old `left` until an unrelated scroll happened to correct it.
 *
 * Fires once per frame for `durationMs` rather than once, because the move is
 * itself animated (`.config` transitions `grid-template-columns` over
 * `--dur-med`): a single sample would just capture some arbitrary point
 * mid-slide.
 */
export function requestArtRemeasure(durationMs = 320): void {
  const until = performance.now() + durationMs;
  const tick = () => {
    window.dispatchEvent(new Event(RELAYOUT_EVENT));
    if (performance.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * Marks where the caller wants the travelling device image to sit right now,
 * and continuously reports that box (on mount, resize, and scroll) through
 * the nearest ArtAnchorContext. The app renders exactly one
 * <PersistentDeviceArt>, under `.content`, which chases the reported box with
 * a plain CSS transition — the same DOM node throughout, so there's nothing
 * to FLIP. Used by every device config tab, and by the Home card of a device
 * whose config tab is open.
 */
export function ArtAnchor({
  mode,
  className,
  style,
  children,
  measureRef,
}: {
  mode: ArtMode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  /**
   * Report a *descendant's* box instead of this wrapper's own — for a
   * wrapper that's deliberately wider than the thing it's actually
   * anchoring (e.g. `.art-keyboard-anchor` spans the full pane width so
   * KeyboardMap's own `fit` sizing has room to compute against, while the
   * rendered board itself, `.kbmap`, is narrower and centred inside it).
   * Without this the travelling photo targeted the wrapper's own (too
   * wide) box instead of where the board visually sits.
   */
  measureRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const report = useContext(ArtAnchorContext);
  /**
   * The photo has lost its target — a new flight started (`setArtFlight`
   * clears it) while this anchor was already mounted and still. Nothing this
   * anchor watches fires for that: no resize, no scroll. So the photo fell
   * back to its flight's own mode ("hero") and sat, fully visible, over the
   * board it should have faded behind, until an unrelated scroll re-measured.
   * Re-reporting whenever the target goes missing closes that gap.
   */
  const targetLost = useStore((s) => s.artTarget === null);

  useLayoutEffect(() => {
    const el = measureRef?.current ?? ref.current;
    if (!el || !report) return;
    const pendingRaf: number[] = [];
    const pendingTimeout: number[] = [];
    const measure = () => {
      const r = el.getBoundingClientRect();
      // A hidden ancestor (e.g. mid tab-switch) collapses this to 0×0 — skip
      // rather than report a bogus target rect.
      if (r.width > 0 && r.height > 0)
        report({ top: r.top, left: r.left, width: r.width, height: r.height }, mode);
    };
    // A measurement can land a frame or two ahead of the layout it's meant
    // to capture — a `position: sticky` anchor's offset depends on a scroll
    // container's real height (`.tabpane-in`'s `container-type: size`, used
    // by `.hero-art-col`'s `50cqh`), a descendant photo with no width/height
    // attribute reflows once it actually decodes, and this element itself
    // going from `display:none` (hidden tab) back to visible re-lays-out a
    // frame after the resize that reveals it. Any of these settling late
    // reported a slightly-wrong rect that only a *subsequent* trigger (the
    // next resize, or the user nudging a scroll) corrected — which is what
    // caused both "off until you scroll" on first opening a tab and "snaps a
    // few pixels into place" right as a flight lands. Two follow-up passes
    // after every trigger below (not just the first) catch that settling
    // without needing something else to happen first.
    const settle = () => {
      measure();
      pendingRaf.push(
        requestAnimationFrame(() => {
          measure();
          pendingRaf.push(requestAnimationFrame(measure));
        }),
      );
      pendingTimeout.push(window.setTimeout(measure, 150));
    };
    settle();
    const ro = new ResizeObserver(settle);
    ro.observe(el);
    // Scroll doesn't change size, so ResizeObserver alone misses it — this
    // anchor can sit inside a scrolling pane (.tabpane-in). Capture phase so
    // any scrolling ancestor is caught, not just window-level scroll.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', settle);
    // A position-only change, announced by requestArtRemeasure above.
    window.addEventListener(RELAYOUT_EVENT, measure);
    // `load` doesn't bubble, but a capture-phase listener still fires on the
    // way down to a descendant <img> regardless — catches a hero photo that
    // finishes decoding after the passes above.
    el.addEventListener('load', settle, true);
    return () => {
      pendingRaf.forEach(cancelAnimationFrame);
      pendingTimeout.forEach(window.clearTimeout);
      ro.disconnect();
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', settle);
      window.removeEventListener(RELAYOUT_EVENT, measure);
      el.removeEventListener('load', settle, true);
    };
  }, [mode, report, targetLost]);

  return (
    <div ref={ref} className={className} style={style}>
      {children}
    </div>
  );
}
