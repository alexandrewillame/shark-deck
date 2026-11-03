/**
 * Inline SVG icon set — no dependency, nothing fetched (the app ships with no
 * network access at all). Every icon is a 16x16 stroke glyph on `currentColor`
 * so it inherits text colour and reacts to hover/active states for free.
 */
import type { SVGProps } from 'react';

export type IconName =
  | 'home'
  | 'marquee'
  | 'mouse'
  | 'keyboard'
  | 'sliders'
  | 'bulb'
  | 'chip'
  | 'bolt'
  | 'gear'
  | 'pencil'
  | 'battery'
  | 'cable'
  | 'shieldCheck'
  | 'warning'
  | 'close'
  | 'macro'
  | 'pair'
  | 'restore'
  | 'chevronRight'
  | 'info'
  | 'palette'
  | 'key'
  | 'gauge'
  | 'cursorClick'
  | 'copy'
  | 'copyRight'
  | 'copyLeft'
  | 'compare'
  | 'check'
  | 'batteryCharging'
  | 'arrowReturn'
  | 'translate'
  | 'panelCollapse'
  | 'wireless'
  | 'windows'
  | 'desktop'
  | 'gamepad'
  | 'trash'
  | 'folder'
  | 'plus'
  | 'pipette'
  | 'lock'
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'backspace'
  | 'clock'
  | 'grip'
  | 'split'
  | 'download'
  | 'upload'
  | 'play'
  | 'trackNext'
  | 'trackPrev'
  | 'mute'
  | 'volumeUp'
  | 'volumeDown'
  | 'enterKey'
  | 'spacebar'
  | 'tabKey'
  | 'shiftKey'
  | 'save'
  | 'undo'
  | 'redo';

const PATHS: Record<IconName, JSX.Element> = {
  home: <path d="M2 8.5 8 3l6 5.5M4 7v6h3v-4h2v4h3V7" />,
  mouse: (
    <>
      <rect x="4" y="1.5" width="8" height="13" rx="4" />
      <path d="M8 1.7v3.9" />
      <rect x="7.15" y="3" width="1.7" height="2.7" rx="0.85" />
      <path d="M4.1 6.3h1.4M4.1 8.1h1.4" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M4 9.5h8" />
    </>
  ),
  sliders: (
    <>
      <path d="M3 3v10M8 3v10M13 3v10" />
      <circle cx="3" cy="6" r="1.4" />
      <circle cx="8" cy="10.5" r="1.4" />
      <circle cx="13" cy="5" r="1.4" />
    </>
  ),
  bulb: (
    <>
      <path d="M8 1.8a4.2 4.2 0 0 0-2.4 7.6c.5.4.9 1 .9 1.6v.5h3v-.5c0-.6.4-1.2.9-1.6A4.2 4.2 0 0 0 8 1.8Z" />
      <path d="M6.3 13.5h3.4M6.8 15h2.4" />
    </>
  ),
  chip: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" />
    </>
  ),
  bolt: <path d="M8.5 1.5 3 9h4l-.5 5.5L13 7H9l-.5-5.5Z" />,
  gear: (
    <>
      {/* proper toothed cog outline (6 teeth) — not the radiating-spokes
          glyph that read as a sparkle. Faceted flanks; round joins soften it. */}
      <path d="M12.09 6.67 13.87 6.75 13.87 9.25 12.09 9.33 11.19 10.88 12.01 12.46 9.85 13.71 8.89 12.21 7.11 12.21 6.15 13.71 3.99 12.46 4.81 10.88 3.91 9.33 2.13 9.25 2.13 6.75 3.91 6.67 4.81 5.12 3.99 3.54 6.15 2.29 7.11 3.79 8.89 3.79 9.85 2.29 12.01 3.54 11.19 5.12Z" />
      <circle cx="8" cy="8" r="2.15" />
    </>
  ),
  pencil: <path d="M10.5 2.5 13.5 5.5 5.5 13.5 2 14l.5-3.5 8-8Z" />,
  battery: (
    <>
      <rect x="1.5" y="5" width="11" height="6" rx="1.2" />
      <path d="M14.5 6.5v3" />
    </>
  ),
  /**
   * The USB trident, authored directly on this file's own 16x16 grid.
   *
   * Chosen by the user over the USB-A connector that was here before. (An
   * earlier note argued a trident "was routinely misread as an unrelated
   * logo" — that was a judgement call, and the user has since seen both.)
   *
   * The extracted 24-grid path this replaces carried only the strokes: its
   * prongs and its shaft simply stopped, with no terminals on them, so the
   * mark read as missing its top-right and right-middle shapes and its base
   * circle came out hollow. What makes this symbol legible is precisely those
   * four solid ends, so they are drawn as filled geometry here rather than
   * stroked outlines, and the transform wrapper is gone with them.
   *
   * Geometry, left to right: filled base circle on the spine at x 2.9; the
   * spine along y 8 to x 12.3, ending in a filled triangle tip at x 15.1;
   * the upper prong leaving the spine at x 6.1, rising to y 4.4 and ending
   * in a filled square; the lower prong leaving at x 7.5, falling to y 11.6
   * and ending in a filled circle.
   */
  cable: (
    <>
      {/* strokes: the spine and the two prongs */}
      <path d="M2.9 8h9.5M6.1 8l2.2-3.6h2.1M7.5 8l1.9 3.6h1.8" />
      {/* filled terminals — the part that makes it read as USB */}
      <circle cx="2.9" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12.2 6.2 15.3 8l-3.1 1.8Z" fill="currentColor" stroke="none" />
      <rect x="10.3" y="3.3" width="2.4" height="2.4" rx="0.3" fill="currentColor" stroke="none" />
      <circle cx="11.6" cy="11.6" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  shieldCheck: (
    <>
      <path d="M8 1.5 13.5 3.5v4c0 4-2.5 6.3-5.5 7-3-.7-5.5-3-5.5-7v-4L8 1.5Z" />
      <path d="M5.7 8.2 7.3 9.8l3-3.2" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2 14.5 13.5h-13L8 2Z" />
      <path d="M8 6.5v3.2M8 11.7h.01" />
    </>
  ),
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  macro: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M5 6h6M5 8.5h6M5 11h3.5" />
    </>
  ),
  pair: (
    <>
      <circle cx="5.5" cy="8" r="3" />
      <circle cx="10.5" cy="8" r="3" />
    </>
  ),
  restore: (
    <>
      <path d="M2.5 8a5.5 5.5 0 1 1 1.9 4.2" />
      <path d="M2.5 4.5V8h3.5" />
    </>
  ),
  chevronRight: <path d="M6 3l5 5-5 5" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v4M8 4.8h.01" />
    </>
  ),
  palette: (
    <>
      <path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c1 0 1.6-.7 1.6-1.5 0-.4-.2-.7-.2-1.1 0-.7.6-1.2 1.3-1.2h1.3c1.5 0 2.7-1.2 2.7-2.7C14.7 4.4 11.7 1.8 8 1.8Z" />
      <circle cx="5" cy="7.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="7.4" cy="4.7" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.4" cy="5.4" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  key: (
    <>
      <circle cx="5" cy="8" r="3.2" />
      <path d="M7.9 8h6.3M11.3 8v2.3M13.1 8v1.6" />
    </>
  ),
  gauge: (
    <>
      <path d="M2 10.5a6 6 0 0 1 12 0" />
      <path d="M8 10.5 11 6" />
      <path d="M2 13.5h12" />
    </>
  ),
  cursorClick: (
    <>
      <path d="M5 2.5v2M2.5 5H4.5M2.7 8.7 4.2 8M8 2.7 7.3 4.2" />
      <path d="M8 8.5 14 11l-2.7.6L10 14.5 8 8.5Z" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5.5" />
    </>
  ),
  /* Copy, and which way: the copy glyph — a sheet over a sheet — with a
     chevron on the side it goes to. The profile comparator's per-key copy,
     where a bare arrow said "move" rather than "copy". `copyLeft` is the
     same glyph mirrored. */
  copyRight: (
    <>
      <rect x="4.25" y="5.25" width="7" height="8.25" rx="1.25" />
      <path d="M8.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25H3A1.25 1.25 0 0 0 1.75 3.5v5.75A1.25 1.25 0 0 0 3 10.5h1.25" />
      <path d="M11.9 9.4h3M13.4 7.8l1.6 1.6-1.6 1.6" />
    </>
  ),
  copyLeft: (
    <g transform="matrix(-1 0 0 1 16 0)">
      <rect x="4.25" y="5.25" width="7" height="8.25" rx="1.25" />
      <path d="M8.75 5.25V3.5a1.25 1.25 0 0 0-1.25-1.25H3A1.25 1.25 0 0 0 1.75 3.5v5.75A1.25 1.25 0 0 0 3 10.5h1.25" />
      <path d="M11.9 9.4h3M13.4 7.8l1.6 1.6-1.6 1.6" />
    </g>
  ),
  /* Two columns side by side with a divider: the profile-compare table, which
     is literally this shape. Not a scales/balance glyph — that reads as
     "weigh up" rather than "show me both". */
  compare: (
    <>
      <rect x="2" y="3" width="5" height="10" rx="1" />
      <rect x="9" y="3" width="5" height="10" rx="1" />
      <path d="M8 1.5v13" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4" />,
  /* Read FROM the device / write TO it. An arrow into or out of a tray, so the
     pair reads as one opposed set wherever both appear on the same panel. */
  download: (
    <>
      <path d="M8 2v7.5M5 7l3 3 3-3" />
      <path d="M2.5 12v1A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </>
  ),
  upload: (
    <>
      <path d="M8 10.5V3M5 6l3-3 3 3" />
      <path d="M2.5 12v1A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5v-1" />
    </>
  ),
  batteryCharging: (
    <>
      <rect x="1.5" y="5" width="11" height="6" rx="1.2" />
      <path d="M14.5 6.5v3" />
      <path d="M8 5.2 5.6 8.4h2l-1.3 2.4 3.6-3.4h-2z" fill="currentColor" stroke="none" />
    </>
  ),
  /** 180° "back to home" return arrow — distinct from the plain arrowLeft. */
  arrowReturn: (
    <>
      <path d="M6.5 4 3 7.5l3.5 3.5" />
      <path d="M3 7.5h6.5a3.5 3.5 0 1 1 0 7H7" />
    </>
  ),
  translate: (
    <>
      <path d="M2 4h7M5.3 2.3v1.7M2.3 4c.4 2.8 1.9 4.9 4 6.3M7.3 4c-.7 2.9-2.4 5.2-5 6.8" />
      <path d="M9.5 14 12.3 7l2.8 7M10.3 12h4" />
    </>
  ),
  panelCollapse: (
    <>
      <rect x="1.8" y="2.5" width="12.4" height="11" rx="1.5" />
      <path d="M6 2.5v11" />
      <path d="M9.5 6.2 7.7 8l1.8 1.8" />
    </>
  ),
  wireless: (
    <>
      <path d="M2.5 6.3a8 8 0 0 1 11 0" />
      <path d="M4.7 8.9a5 5 0 0 1 6.6 0" />
      <path d="M7 11.4a2 2 0 0 1 2 0" />
      <circle cx="8" cy="13.2" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  /** the "Desktop" built-in profile's icon */
  windows: (
    <path d="M2 3.3 7.3 2.6V7.7H2ZM8.3 2.5 14 1.7V7.6H8.3ZM2 8.7H7.3V13.8L2 13.1ZM8.3 8.7H14V14.3L8.3 13.5Z" />
  ),
  /** the "Desktop" built-in profile's icon on macOS and Linux — a monitor,
   *  where the Windows logo would name the wrong OS */
  desktop: (
    <>
      <rect x="2" y="2.8" width="12" height="8.4" rx="1.2" />
      <path d="M6 13.8h4M8 11.2v2.6" />
    </>
  ),
  /** the "Gaming" built-in profile's icon */
  gamepad: (
    <>
      <path d="M4.3 4.5h7.4a3 3 0 0 1 2.9 3.7l-.7 3a2 2 0 0 1-3.3 1L9 10.7H7l-1.6 1.5a2 2 0 0 1-3.3-1l-.7-3a3 3 0 0 1 2.9-3.7Z" />
      <path d="M4.6 7v2.2M3.5 8.1h2.2" />
      <circle cx="10" cy="6.8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="11.6" cy="8.4" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  trash: (
    <>
      <path d="M2.5 4.2h11M6 4.2V2.7h4v1.5" />
      <path d="M3.6 4.2 4.2 13a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.6-8.8" />
      <path d="M6.5 7v4M9.5 7v4" />
    </>
  ),
  plus: <path d="M8 2.5v11M2.5 8h11" />,
  // Dashed rectangle — the standard "drag a selection box" glyph.
  marquee: <rect x="2.5" y="3.5" width="11" height="9" rx="1" strokeDasharray="2.4 1.8" />,
  /**
   * The Photoshop eyedropper: a solid rounded bulb, a wider solid collar, and a
   * thin hollow tube tapering to a slanted tip — drawn upright and turned 45deg,
   * so the bulb sits top-right and the tip bottom-left, and the geometry stays
   * legible to edit. The tube's outline is a hair thinner than the set's 1.5
   * so its hollow still shows at 17px.
   */
  pipette: (
    <g transform="rotate(45 8 8)">
      <path d="M5.7 3.6V0.9a2.3 2.3 0 0 1 4.6 0v2.7Z" fill="currentColor" stroke="none" />
      <rect x="4.6" y="3.3" width="6.8" height="2.6" rx="1.1" fill="currentColor" stroke="none" />
      <path d="M6.75 5.9v7.4l.85 3.1h.8l.85-3.1V5.9" strokeWidth={1} />
    </g>
  ),
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
      <path d="M5.2 7V5a2.8 2.8 0 0 1 5.6 0v2" />
    </>
  ),
  folder: (
    <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l2 2h4A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5Z" />
  ),
  // Keyboard-map arrow-key glyphs (KeyboardMap.tsx) — a plain line + chevron
  // head, matching a real arrow-key legend rather than a spelled-out label.
  grip: (
    <>
      <circle cx="6" cy="4" r="1" />
      <circle cx="10" cy="4" r="1" />
      <circle cx="6" cy="8" r="1" />
      <circle cx="10" cy="8" r="1" />
      <circle cx="6" cy="12" r="1" />
      <circle cx="10" cy="12" r="1" />
    </>
  ),
  // Breaking one combined row back into its two halves.
  split: (
    <>
      <path d="M3 8h4M9 8h4" />
      <path d="M8 2.5v3M8 10.5v3" />
    </>
  ),
  /* Media transport, for the remap picker: a media key has a universally
     recognised glyph, and "Play/Pause" spelled out in a 6-character button
     read as a word you had to stop and parse. */
  play: (
    <>
      <path d="M3 3.4v9.2l6-4.6z" />
      <path d="M11 3.6v8.8M13.4 3.6v8.8" />
    </>
  ),
  trackNext: (
    <>
      <path d="M3.5 3.6v8.8l6.2-4.4z" />
      <path d="M11.8 3.6v8.8" />
    </>
  ),
  trackPrev: (
    <>
      <path d="M12.5 3.6v8.8L6.3 8z" />
      <path d="M4.2 3.6v8.8" />
    </>
  ),
  mute: (
    <>
      <path d="M2 6.2h2.4L7.6 3.4v9.2L4.4 9.8H2z" />
      <path d="m10.4 6.2 3.2 3.6M13.6 6.2l-3.2 3.6" />
    </>
  ),
  volumeUp: (
    <>
      <path d="M2 6.2h2.4L7.6 3.4v9.2L4.4 9.8H2z" />
      <path d="M12 5.2v5.6M9.2 8h5.6" />
    </>
  ),
  volumeDown: (
    <>
      <path d="M2 6.2h2.4L7.6 3.4v9.2L4.4 9.8H2z" />
      <path d="M9.2 8h5.6" />
    </>
  ),
  /**
   * Enter, as the glyph printed on the key: down the right, then left, with the
   * arrowhead at the end. `arrowReturn` is a curl used for "revert" elsewhere
   * in the app and read as one here.
   */
  enterKey: <path d="M13 3.6v5.2H4.2M7.4 5.6 4.2 8.8l3.2 3.2" />,
  /** A spacebar: the wide cap itself, with the two ends it is drawn with. */
  spacebar: <path d="M2.4 6.4v3.2h11.2V6.4" />,
  /** Tab, as printed on the key: an arrow to a bar, over an arrow to a bar,
   *  pointing opposite ways. */
  tabKey: (
    <path d="M2.5 5h9.3M9.4 2.8 11.8 5 9.4 7.2M13.5 2.8v4.4M13.5 11H4.2M6.6 8.8 4.2 11l2.4 2.2M2.5 8.8v4.4" />
  ),
  /** Shift, as printed on the key: the HOLLOW up arrow (⇧, ISO 9995-7) — an
   *  outline, so it never reads as the solid Up arrow key. */
  shiftKey: <path d="M8 2.2 2.6 8h3.1v5.6h4.6V8h3.1Z" />,
  /** A floppy disk — "save": the body with its cut corner, the shutter, the label. */
  save: (
    <>
      <path d="M3.5 2.5h7l3 3v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z" />
      <path d="M5.5 2.5v3H10v-3" />
      <path d="M5 13.5v-4h6v4" />
    </>
  ),
  undo: (
    <>
      <path d="M5.5 3.5 2.5 6.5l3 3" />
      <path d="M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7" />
    </>
  ),
  redo: (
    <>
      <path d="M10.5 3.5l3 3-3 3" />
      <path d="M13.5 6.5h-7a3.5 3.5 0 0 0 0 7H9" />
    </>
  ),
  arrowUp: <path d="M8 12.5V3.2M4.4 6.8 8 3.2l3.6 3.6" />,
  arrowDown: <path d="M8 3.5v9.3M4.4 9.2 8 12.8l3.6-3.6" />,
  arrowLeft: <path d="M12.5 8H3.2M6.8 4.4 3.2 8l3.6 3.6" />,
  arrowRight: <path d="M3.5 8h9.3M9.2 4.4 12.8 8l-3.6 3.6" />,
  /**
   * Backspace, as printed on the key: the LONG left arrow (⟵, ISO 9995-7 and
   * every AZERTY/QWERTZ board). It was the ⌫ erase-left tag, which is a phone's
   * and a Mac's delete key rather than the glyph on a PC keyboard. Longer than
   * `arrowLeft` with a smaller head, so it does not read as the Left key.
   */
  backspace: <path d="M14.6 8H1.9M5.1 5 1.9 8l3.2 3" />,
  // A pause in a macro (the `wait` step row) — a clock face rather than the
  // media "pause" bars, which in this app already mean a suspended
  // auto-switch and would read as that here.
  clock: (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 4.9V8l2.3 1.6" />
    </>
  ),
};

/**
 * How a requested `size` becomes a rendered pixel size.
 *
 * Call sites ask for 11-14px, sized by eye against the text beside them — but
 * most of these glyphs sit alone in a 26-34px button, where a 12px stroke icon
 * reads as a speck in a box rather than as the button's subject. Scaled in ONE
 * place instead of re-tuning ~55 call sites, because tuning them individually
 * is exactly how they drifted small in the first place: every future `size={12}`
 * gets the same correction automatically.
 *
 * A floor as well as a scale, so the smallest few (11px, inside dense list
 * rows) come up to something clickable without dragging the whole set up.
 */
const ICON_SCALE = 1.3;
const ICON_MIN_PX = 14;
export const iconPx = (size: number) => Math.max(ICON_MIN_PX, Math.round(size * ICON_SCALE));

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const px = iconPx(size);
  return (
    <svg
      viewBox="0 0 16 16"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
