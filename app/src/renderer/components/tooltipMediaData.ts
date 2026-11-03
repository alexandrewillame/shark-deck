/**
 * Animation definitions for sensor-option tooltips. Each animation is defined
 * once here and can be rendered by both the React tooltipMedia.tsx component
 * and the standalone tooltipMedia.html preview (which reads this file via
 * import or manual JSON export).
 *
 * To add a new animation:
 * 1. Add an entry to the ANIMATIONS array below
 * 2. Both React and the HTML preview will automatically pick it up
 *
 * A word drawn in a picture is written in English on a `<text>` that carries
 * `data-i18n="key"` (a key in shared/i18n/en.ts holding that same English).
 * `localizeSvg` swaps it for `t(key)` when the app renders the picture; the
 * preview page shows the English as written. Numbers and units ("125 Hz",
 * "400") are not tagged. tooltipMediaData.test.ts holds every tag to the
 * catalogue and fails on an untagged word.
 */
import type { MessageKey, TFunc } from '@shared/i18n';

export interface TooltipAnimation {
  id: string;
  /** The preview page's card heading and caption (generate-tooltip-preview.mjs)
   *  — never shown in the app, so they stay English. */
  label: string;
  description: string;
  svgContent: string; // Raw SVG markup (without outer <svg> tag)
}

/** A tagged word: the opening tag, its key, and its text — up to the first
 *  child element, which is how a `<text>` that animates its own opacity reads. */
const I18N_TEXT = /(<text\b[^>]*\sdata-i18n="([\w.]+)"[^>]*>)([^<]*)/g;

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Every tagged word in some markup, as `[key, the English written there]`. */
export function svgWords(svg: string): Array<[string, string]> {
  return [...svg.matchAll(I18N_TEXT)].map((m) => [m[2]!, m[3]!]);
}

/**
 * The markup with every tagged word in the app's language. Escaped, because
 * the result is parsed as HTML (see RenderAnimation in tooltipMedia.tsx) and a
 * translation is free to contain `<` or `&`.
 */
export function localizeSvg(svg: string, t: TFunc): string {
  return svg.replace(
    I18N_TEXT,
    (_, open: string, key: string) => open + escapeXml(t(key as MessageKey)),
  );
}

export const ANIMATIONS: TooltipAnimation[] = [
  {
    id: 'rippleControl',
    label: 'Ripple Control',
    description:
      'The raw jittery trace drawn by one dot, and the smoothed trace following the same path a hair later',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // Both traces draw in from the left (stroke-dasharray = the path's own
    // length, offset animated down to 0) with a dot riding the tip. The raw
    // polyline is the smooth curve sampled every ~8px with a fixed ±3.5px
    // jitter; the smoothed trace runs the same loop 0.05 later, and that gap
    // IS the added latency the tooltip text warns about — deliberate, small.
    // The dasharray lengths are measured (262.7 / 224.6), not guessed: an
    // over-long one finishes the reveal early and leaves the dot trailing an
    // already-complete line.
    svgContent: `
      <text x="8" y="14" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.ripple.raw">raw</text>
      <path d="M20 34 L28.6 33.4 L37.1 27.1 L45.7 31.3 L54.3 25 L62.9 30.8 L71.4 28 L80 35.5 L88.6 32 L97.1 36.7 L105.7 32.5 L114.3 38.2 L122.9 32.9 L131.4 36.1 L140 26.5 L148.4 28.9 L156.6 23.7 L164.4 27.6 L172.1 22.4 L179.5 27.5 L186.7 24.5 L193.8 32.8 L200.6 29 L207.4 35.2 L214.1 30.8 L220.6 36.4 L227.1 30.6 L233.6 34.2 L240 30"
        fill="none" stroke="var(--red)" stroke-width="1.5" stroke-linejoin="round" opacity="0.8"
        stroke-dasharray="263" stroke-dashoffset="263">
        <animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite" keyTimes="0;0.72;1" values="263;0;0" />
      </path>
      <circle r="3" fill="var(--red)">
        <animateMotion dur="3s" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.72;1" keyPoints="0;1;1"
          path="M20 34 L28.6 33.4 L37.1 27.1 L45.7 31.3 L54.3 25 L62.9 30.8 L71.4 28 L80 35.5 L88.6 32 L97.1 36.7 L105.7 32.5 L114.3 38.2 L122.9 32.9 L131.4 36.1 L140 26.5 L148.4 28.9 L156.6 23.7 L164.4 27.6 L172.1 22.4 L179.5 27.5 L186.7 24.5 L193.8 32.8 L200.6 29 L207.4 35.2 L214.1 30.8 L220.6 36.4 L227.1 30.6 L233.6 34.2 L240 30" />
      </circle>
      <text x="8" y="66" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.ripple.smoothed">smoothed (slightly later)</text>
      <path d="M20 86 C60 68 100 100 140 82 C180 64 210 98 240 82"
        fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"
        stroke-dasharray="225" stroke-dashoffset="225">
        <animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite" keyTimes="0;0.05;0.77;1" values="225;225;0;0" />
      </path>
      <circle r="3" fill="var(--accent)">
        <animateMotion dur="3s" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.05;0.77;1" keyPoints="0;0;1;1"
          path="M20 86 C60 68 100 100 140 82 C180 64 210 98 240 82" />
      </circle>
    `,
  },
  {
    id: 'angleSnapping',
    label: 'Angle Snapping',
    description: 'A wobbly hand-drawn stroke, snapped straight on screen',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    svgContent: `
      <text x="8" y="16" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.yourHand">your hand</text>
      <!-- Draws in over the first 40% of the loop, then *holds* fully drawn
           for the rest of it — the only "disappear" is the instantaneous
           reset at the loop seam, not a held invisible phase, so the lines
           read as staying put once finished instead of vanishing right
           after completing. -->
      <path d="M10 40 Q30 30 45 42 T80 38 T115 46 T150 36 T185 44 T220 34 T250 40"
        fill="none" stroke="var(--red)" stroke-width="1.5" stroke-linecap="round"
        stroke-dasharray="420" stroke-dashoffset="420">
        <animate attributeName="stroke-dashoffset" dur="2.6s" repeatCount="indefinite"
          keyTimes="0;0.4;1" values="420;0;0" />
      </path>
      <circle r="3.5" fill="var(--red)">
        <animateMotion dur="2.6s" repeatCount="indefinite" keyTimes="0;0.4;1" keyPoints="0;1;1" calcMode="linear"
          path="M10 40 Q30 30 45 42 T80 38 T115 46 T150 36 T185 44 T220 34 T250 40" />
      </circle>
      <text x="8" y="80" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.onScreen">on screen</text>
      <line x1="10" y1="90" x2="250" y2="90" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round"
        stroke-dasharray="240" stroke-dashoffset="240">
        <animate attributeName="stroke-dashoffset" dur="2.6s" repeatCount="indefinite"
          keyTimes="0;0.4;1" values="240;0;0" />
      </line>
    `,
  },
  {
    id: 'motionSync',
    label: 'Motion Sync',
    description:
      'Sensor reads slide into place just before each USB report; off, some land after it and the report goes out stale',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // Two states, each held for 1.2s with a 0.3s eased slide between them.
    // "off": the reads are irregular, and three of them land just AFTER the
    // report they were needed for (drawn red — that report went out with the
    // previous, stale read). "on": every read slides to 5px before its
    // report. The report row never moves — it is the fixed clock the sensor
    // is being timed against. Only `x` and `opacity` animate; the red ticks
    // are separate overlays rather than an animated stroke colour, since SMIL
    // cannot animate to a CSS custom property in Chromium (see
    // liftOffDistance). The right-hand label flips mid-slide, in step.
    svgContent: `
      <text x="8" y="36" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.motionSync.reads">sensor reads</text>
      <line x1="66" y1="42" x2="250" y2="42" stroke="currentColor" stroke-width="1" opacity="0.15" />
      <g fill="var(--violet)">
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="71;71;75;75;71" /></rect>
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="110;110;101;101;110" /></rect>
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="124;124;127;127;124" /></rect>
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="163;163;153;153;163" /></rect>
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="174;174;179;179;174" /></rect>
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="214;214;205;205;214" /></rect>
        <rect y="22" width="2" height="20" rx="1"><animate attributeName="x" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.4;0.5;0.9;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="227;227;231;231;227" /></rect>
      </g>
      <!-- the reads that arrived after their report: red while sync is off -->
      <g fill="var(--red)">
        <rect x="110" y="22" width="2" height="20" rx="1"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.4;1" values="1;0;0" /></rect>
        <rect x="163" y="22" width="2" height="20" rx="1"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.4;1" values="1;0;0" /></rect>
        <rect x="214" y="22" width="2" height="20" rx="1"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.4;1" values="1;0;0" /></rect>
      </g>
      <text x="8" y="64" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.motionSync.reports">USB reports</text>
      <line x1="66" y1="70" x2="250" y2="70" stroke="currentColor" stroke-width="1" opacity="0.15" />
      <g fill="var(--accent)">
        <rect x="80" y="50" width="2" height="20" rx="1" /><rect x="106" y="50" width="2" height="20" rx="1" />
        <rect x="132" y="50" width="2" height="20" rx="1" /><rect x="158" y="50" width="2" height="20" rx="1" />
        <rect x="184" y="50" width="2" height="20" rx="1" /><rect x="210" y="50" width="2" height="20" rx="1" />
        <rect x="236" y="50" width="2" height="20" rx="1" />
      </g>
      <text x="8" y="98" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.motionSync.legend">red = read after its report (stale)</text>
      <text x="250" y="98" text-anchor="end" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.motionSync.off">off<animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.45;0.95;1" values="1;0;1;1" /></text>
      <text x="250" y="98" text-anchor="end" font-size="9" fill="var(--accent)" data-i18n="tipmedia.motionSync.synced">synced<animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.45;0.95;1" values="0;1;0;0" /></text>
    `,
  },
  {
    id: 'liftOffDistance',
    label: 'Lift-Off Distance',
    description:
      'Side-on gaming mouse rising past the lift-off threshold, turning red while it can’t track',
    // NB: attributes are kebab-case (stroke-width, font-size) — svgContent is
    // parsed as HTML via dangerouslySetInnerHTML, which does not fix up
    // camelCase SVG presentation attributes.
    svgContent: `
      <defs>
        <pattern id="lod-ground" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(0)">
          <path d="M0 9 L9 0" stroke="var(--text-mut)" stroke-width="1" />
        </pattern>
      </defs>
      <!-- ground: solid line + hatched fill beneath it -->
      <rect x="10" y="90" width="240" height="14" fill="url(#lod-ground)" opacity="0.7" />
      <line x1="10" y1="90" x2="250" y2="90" stroke="var(--text)" stroke-width="2" />
      <!-- lift-off threshold -->
      <line x1="10" y1="66" x2="250" y2="66" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" />
      <text x="250" y="60" text-anchor="end" font-size="9" fill="var(--accent)" data-i18n="tipmedia.lod">lift-off distance</text>
      <!-- A computer mouse seen side-on, front to the left: a flat base on
           two skates, the shell rising to the palm hump and rounding off at
           the back, the seam where the left button meets the shell, a
           rounded scroll wheel standing out of the top, two side buttons, and
           the sensor's glow under the middle. (The first drawing was a hump
           with a pointed notch on top and a dot at its nose — an animal
           mouse, ear and all.) Neutral/tracking while below the
           threshold, red/not-tracking while above it, switching the instant
           its base crosses the dashed line, not gradually.
           NB: color-animating fill/stroke via SMIL animate does not resolve
           CSS custom properties (var(--x)) in Chromium — the values list is
           parsed as raw SVG colors, and var(...) isn't one, so the
           animation silently no-ops and the shape never actually changes
           colour. Literal colours (and the currentColor keyword, which IS a
           real SVG colour value and does animate) are used here instead —
           currentColor picks up the tooltip's own color (--text-dim), so
           the resting state still adapts to the light/dark theme; only the
           alert colour is a fixed literal, since "turns red" is the whole
           point. calcMode="discrete" is what makes the switch instant —
           without it these interpolate smoothly between the two colours
           over each keyTime span, which read as a slow fade rather than a
           snap the moment the threshold is crossed.
           The colour keyTimes (0.17 / 0.72) don't match the lift transform's
           own (0.4 / 0.6, its full-height plateau) — the lift keeps its own
           easing curve, but the mouse's *base* actually crosses the
           threshold line partway through the rise/fall, well before/after
           it reaches full height, so the colour switch is timed to when
           that crossing actually happens instead of only the fully-lifted
           extremes. Solved for exactly: the lift travels 34px total and the
           base starts 22px below the threshold line, so the crossing is at
           22/34 of the *distance* travelled; run back through the lift's
           own cubic-bezier easing (keySplines "0.4 0 0.2 1") to find the
           *time* fraction that produces that distance fraction — not the
           same fraction, since the curve isn't linear — gives ~0.167 of the
           way through the up segment (½0.4) and, by the same maths on the
           way down, ~0.72 overall for the down-crossing. An earlier pass
           used a rough visual guess (0.28) for the up-crossing instead of
           actually solving the easing curve, which is what left the colour
           switching later than the real crossing. -->
      <g>
        <animateTransform attributeName="transform" type="translate" dur="2.8s" repeatCount="indefinite" keyTimes="0;0.4;0.6;1" values="0 0; 0 -34; 0 -34; 0 0" calcMode="spline" keySplines="0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" />
        <g fill="none" stroke-linejoin="round" stroke-linecap="round">
          <animate attributeName="stroke" dur="2.8s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.17;0.72;1" values="currentColor;#ff5c6c;currentColor;currentColor" />
          <!-- shell: flat base, low nose, palm hump, rounded tail -->
          <path d="M40 87 C33 87 31 80 37 76 C51 65 70 55 92 53 C110 52 123 61 124 74 C125 82 122 87 117 87 Z" stroke-width="1.5" />
          <!-- the left button's seam, running back from the nose -->
          <path d="M41 75 C52 67 61 62 70 59" stroke-width="1" />
          <!-- scroll wheel standing out of the top -->
          <rect x="66" y="52.5" width="10" height="5" rx="2.5" stroke-width="1.2" transform="rotate(-20 71 55)" />
          <!-- two side buttons -->
          <rect x="74" y="67" width="9" height="4" rx="2" stroke-width="1" />
          <rect x="86" y="67" width="9" height="4" rx="2" stroke-width="1" />
          <!-- skates -->
          <path d="M48 89 H62 M98 89 H112" stroke-width="2" />
        </g>
        <!-- the sensor's light on the surface: bright while tracking, dim once lifted -->
        <ellipse cx="80" cy="88" rx="6" ry="1.6">
          <animate attributeName="fill" dur="2.8s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.17;0.72;1" values="currentColor;#ff5c6c;currentColor;currentColor" />
          <animate attributeName="opacity" dur="2.8s" repeatCount="indefinite" keyTimes="0;0.4;0.6;1" values="1;0.2;0.2;1" />
        </ellipse>
      </g>
    `,
  },
  {
    id: 'reportRate',
    label: 'Report rate',
    description:
      'The same cursor move sampled at 125 Hz and at 1000 Hz: same speed, eight times as many reports land',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // One curve drawn twice. A dot rides each copy at the SAME constant speed
    // (animateMotion, keyPoints linear in arc length), so the only difference
    // between the rows is how many samples drop as it passes: 6 on the top
    // row, 24 on the bottom. Each sample is pre-placed at its arc-length
    // fraction along the curve (measured, length 200.7) and switches on,
    // discretely, at the moment the dot reaches it; the dot travels for 85%
    // of the loop and the finished picture holds for the rest.
    svgContent: `
      <text x="8" y="36" font-size="9" fill="var(--text-mut)">125 Hz</text>
      <path d="M52 34 C96 10 136 52 176 28 C200 14 226 20 246 30" fill="none" stroke="currentColor" stroke-width="1" opacity="0.18" />
      <g fill="var(--violet)">
        <circle cx="67.6" cy="28" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.071;1" values="0;1;1" /></circle>
        <circle cx="100.8" cy="28" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.213;1" values="0;1;1" /></circle>
        <circle cx="133.6" cy="34.6" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.354;1" values="0;1;1" /></circle>
        <circle cx="166.6" cy="32.5" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.496;1" values="0;1;1" /></circle>
        <circle cx="197.5" cy="20.4" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.638;1" values="0;1;1" /></circle>
        <circle cx="230.5" cy="23.7" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.779;1" values="0;1;1" /></circle>
      </g>
      <circle r="3.2" fill="currentColor">
        <animateMotion dur="3s" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.85;1" keyPoints="0;1;1" path="M52 34 C96 10 136 52 176 28 C200 14 226 20 246 30" />
      </circle>
      <text x="8" y="88" font-size="9" fill="var(--text-mut)">1000 Hz</text>
      <path d="M52 86 C96 62 136 104 176 80 C200 66 226 72 246 82" fill="none" stroke="currentColor" stroke-width="1" opacity="0.18" />
      <g fill="var(--accent)">
        <circle cx="55.7" cy="84.1" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.018;1" values="0;1;1" /></circle>
        <circle cx="63.5" cy="81.1" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.053;1" values="0;1;1" /></circle>
        <circle cx="71.7" cy="79.2" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.089;1" values="0;1;1" /></circle>
        <circle cx="80" cy="78.4" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.124;1" values="0;1;1" /></circle>
        <circle cx="88.3" cy="78.5" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.159;1" values="0;1;1" /></circle>
        <circle cx="96.6" cy="79.4" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.195;1" values="0;1;1" /></circle>
        <circle cx="104.9" cy="80.8" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.23;1" values="0;1;1" /></circle>
        <circle cx="113.1" cy="82.5" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.266;1" values="0;1;1" /></circle>
        <circle cx="121.2" cy="84.2" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.301;1" values="0;1;1" /></circle>
        <circle cx="129.4" cy="85.9" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.336;1" values="0;1;1" /></circle>
        <circle cx="137.7" cy="87.1" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.372;1" values="0;1;1" /></circle>
        <circle cx="146" cy="87.7" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.407;1" values="0;1;1" /></circle>
        <circle cx="154.4" cy="87.3" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.443;1" values="0;1;1" /></circle>
        <circle cx="162.6" cy="85.8" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.478;1" values="0;1;1" /></circle>
        <circle cx="170.4" cy="82.9" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.514;1" values="0;1;1" /></circle>
        <circle cx="177.8" cy="79" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.549;1" values="0;1;1" /></circle>
        <circle cx="185.4" cy="75.5" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.584;1" values="0;1;1" /></circle>
        <circle cx="193.4" cy="73.2" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.62;1" values="0;1;1" /></circle>
        <circle cx="201.7" cy="72" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.655;1" values="0;1;1" /></circle>
        <circle cx="210.1" cy="71.8" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.691;1" values="0;1;1" /></circle>
        <circle cx="218.4" cy="72.7" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.726;1" values="0;1;1" /></circle>
        <circle cx="226.5" cy="74.5" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.761;1" values="0;1;1" /></circle>
        <circle cx="234.5" cy="77" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.797;1" values="0;1;1" /></circle>
        <circle cx="242.2" cy="80.2" r="2.2" opacity="0"><animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.832;1" values="0;1;1" /></circle>
      </g>
      <circle r="3.2" fill="currentColor">
        <animateMotion dur="3s" repeatCount="indefinite" calcMode="linear" keyTimes="0;0.85;1" keyPoints="0;1;1" path="M52 86 C96 62 136 104 176 80 C200 66 226 72 246 82" />
      </circle>
    `,
  },
  {
    id: 'sensorMode',
    label: 'Sensor mode',
    description:
      'A sweep lights each measurement: LP samples sparsely, HP densely, while the reports to the PC keep their own unchanged rate',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // The three rows are as before (same sample positions); what moves is a
    // thin sweep crossing every row at the same speed, 20 -> 240 over the 3s
    // loop, with a ring flaring off each dot as the sweep reaches it. So the
    // rows pulse at their own density — 5, 12 and 8 beats per pass — and the
    // bottom row keeps beating the same way whichever sensor mode is picked,
    // which is the whole point. Each ring's `begin` is solved from its x:
    // (x - 20) / 220 * 3s; it repeats every 3s from there, in step with the
    // sweep, and sits at opacity 0 until its first beat.
    svgContent: `
      <text x="8" y="14" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.sensorMode.lp">sensor measures · LP</text>
      <line x1="20" y1="26" x2="240" y2="26" stroke="var(--bg-3)" stroke-width="1" />
      <g fill="var(--violet)">
        <circle cx="34" cy="26" r="2.6" /><circle cx="78" cy="26" r="2.6" /><circle cx="122" cy="26" r="2.6" />
        <circle cx="166" cy="26" r="2.6" /><circle cx="210" cy="26" r="2.6" />
      </g>
      <g fill="none" stroke="var(--violet)" stroke-width="1.4">
        <circle cx="34" cy="26" r="2.6" opacity="0"><animate attributeName="r" begin="0.191s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.191s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="78" cy="26" r="2.6" opacity="0"><animate attributeName="r" begin="0.791s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.791s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="122" cy="26" r="2.6" opacity="0"><animate attributeName="r" begin="1.391s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.391s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="166" cy="26" r="2.6" opacity="0"><animate attributeName="r" begin="1.991s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.991s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="210" cy="26" r="2.6" opacity="0"><animate attributeName="r" begin="2.591s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.591s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
      </g>
      <rect y="20" width="1.2" height="12" fill="currentColor" opacity="0.35"><animate attributeName="x" dur="3s" repeatCount="indefinite" values="20;240" /></rect>
      <text x="8" y="48" font-size="9" fill="var(--accent)" data-i18n="tipmedia.sensorMode.hp">sensor measures · HP</text>
      <line x1="20" y1="60" x2="240" y2="60" stroke="var(--bg-3)" stroke-width="1" />
      <g fill="var(--accent)">
        <circle cx="26" cy="60" r="2.6" /><circle cx="44" cy="60" r="2.6" /><circle cx="62" cy="60" r="2.6" />
        <circle cx="80" cy="60" r="2.6" /><circle cx="98" cy="60" r="2.6" /><circle cx="116" cy="60" r="2.6" />
        <circle cx="134" cy="60" r="2.6" /><circle cx="152" cy="60" r="2.6" /><circle cx="170" cy="60" r="2.6" />
        <circle cx="188" cy="60" r="2.6" /><circle cx="206" cy="60" r="2.6" /><circle cx="224" cy="60" r="2.6" />
      </g>
      <g fill="none" stroke="var(--accent)" stroke-width="1.4">
        <circle cx="26" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="0.082s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.082s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="44" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="0.327s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.327s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="62" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="0.573s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.573s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="80" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="0.818s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.818s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="98" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="1.064s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.064s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="116" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="1.309s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.309s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="134" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="1.555s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.555s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="152" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="1.8s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.8s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="170" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="2.045s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.045s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="188" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="2.291s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.291s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="206" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="2.536s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.536s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="224" cy="60" r="2.6" opacity="0"><animate attributeName="r" begin="2.782s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.782s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
      </g>
      <rect y="54" width="1.2" height="12" fill="currentColor" opacity="0.35"><animate attributeName="x" dur="3s" repeatCount="indefinite" values="20;240" /></rect>
      <line x1="8" y1="74" x2="252" y2="74" stroke="var(--line)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />
      <text x="8" y="90" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.sensorMode.reports">mouse reports to PC · unchanged</text>
      <line x1="20" y1="100" x2="240" y2="100" stroke="var(--bg-3)" stroke-width="1" />
      <g fill="var(--text-mut)">
        <circle cx="30" cy="100" r="2.6" /><circle cx="57" cy="100" r="2.6" /><circle cx="84" cy="100" r="2.6" />
        <circle cx="111" cy="100" r="2.6" /><circle cx="138" cy="100" r="2.6" /><circle cx="165" cy="100" r="2.6" />
        <circle cx="192" cy="100" r="2.6" /><circle cx="219" cy="100" r="2.6" />
      </g>
      <g fill="none" stroke="var(--text-mut)" stroke-width="1.4">
        <circle cx="30" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="0.136s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.136s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="57" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="0.505s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.505s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="84" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="0.873s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="0.873s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="111" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="1.241s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.241s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="138" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="1.609s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.609s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="165" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="1.977s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="1.977s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="192" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="2.345s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.345s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
        <circle cx="219" cy="100" r="2.6" opacity="0"><animate attributeName="r" begin="2.714s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="2.6;7;7" /><animate attributeName="opacity" begin="2.714s" dur="3s" repeatCount="indefinite" keyTimes="0;0.1;1" values="0.9;0;0" /></circle>
      </g>
      <rect y="94" width="1.2" height="12" fill="currentColor" opacity="0.35"><animate attributeName="x" dur="3s" repeatCount="indefinite" values="20;240" /></rect>
    `,
  },
  {
    id: 'sensorFps',
    label: '20 kHz FPS scanning',
    description:
      'The surface slides under the sensor eye; at 20 kHz it captures frames far more often than normal',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // This is the SENSOR's frame rate, not the USB report rate (that one is
    // `reportRate`), so there are no report ticks here at all: just a textured
    // surface sliding left under a stationary eye — the mouse moving over the
    // pad — and a flash each time the eye grabs a frame. Both rows' flashes
    // have the same shape (30ms up, 75ms down); only the cadence differs, one
    // every 0.75s against one every 0.15s, and both divide the 3s loop. The
    // texture is two dashed lines whose dash patterns each sum to 30, with
    // the offset animated over 150 = 5 whole periods per loop, so the slide
    // never visibly restarts.
    svgContent: `
      <text x="8" y="40" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.fps.normal">normal</text>
      <rect x="60" y="30" width="190" height="14" rx="2" fill="var(--bg-3)" stroke="var(--line)" />
      <line x1="60" y1="35" x2="250" y2="35" stroke="var(--text-mut)" stroke-width="1.2" opacity="0.55" stroke-dasharray="4 6 7 5 2 6"><animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite" values="0;150" /></line>
      <line x1="60" y1="40" x2="250" y2="40" stroke="var(--text-mut)" stroke-width="1.2" opacity="0.55" stroke-dasharray="6 4 3 7 5 5"><animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite" values="0;150" /></line>
      <polygon points="152,24 158,24 166,44 144,44" fill="var(--accent)" opacity="0"><animate attributeName="opacity" dur="0.75s" repeatCount="indefinite" keyTimes="0;0.04;0.14;1" values="0;0.3;0;0" /></polygon>
      <rect x="143" y="12" width="24" height="12" rx="3" fill="var(--bg-3)" stroke="currentColor" stroke-width="1" />
      <circle cx="155" cy="18" r="3" fill="var(--accent)" opacity="0.3" />
      <circle cx="155" cy="18" r="3" fill="var(--accent)" opacity="0"><animate attributeName="opacity" dur="0.75s" repeatCount="indefinite" keyTimes="0;0.04;0.14;1" values="0;1;0;0" /></circle>
      <text x="8" y="86" font-size="9" fill="var(--text-mut)">20 kHz</text>
      <rect x="60" y="76" width="190" height="14" rx="2" fill="var(--bg-3)" stroke="var(--line)" />
      <line x1="60" y1="81" x2="250" y2="81" stroke="var(--text-mut)" stroke-width="1.2" opacity="0.55" stroke-dasharray="4 6 7 5 2 6"><animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite" values="0;150" /></line>
      <line x1="60" y1="86" x2="250" y2="86" stroke="var(--text-mut)" stroke-width="1.2" opacity="0.55" stroke-dasharray="6 4 3 7 5 5"><animate attributeName="stroke-dashoffset" dur="3s" repeatCount="indefinite" values="0;150" /></line>
      <polygon points="152,70 158,70 166,90 144,90" fill="var(--accent)" opacity="0"><animate attributeName="opacity" dur="0.15s" repeatCount="indefinite" keyTimes="0;0.2;0.7;1" values="0;0.3;0;0" /></polygon>
      <rect x="143" y="58" width="24" height="12" rx="3" fill="var(--bg-3)" stroke="currentColor" stroke-width="1" />
      <circle cx="155" cy="64" r="3" fill="var(--accent)" opacity="0.3" />
      <circle cx="155" cy="64" r="3" fill="var(--accent)" opacity="0"><animate attributeName="opacity" dur="0.15s" repeatCount="indefinite" keyTimes="0;0.2;0.7;1" values="0;1;0;0" /></circle>
    `,
  },
  {
    id: 'longDistance',
    label: 'Long-distance mode',
    description: 'Boosts receiver range at a noticeable power cost',
    svgContent: `
      <circle cx="40" cy="55" r="6" fill="var(--accent)" />
      <text x="40" y="80" text-anchor="middle" font-size="8" fill="var(--text-mut)" data-i18n="tipmedia.longRange.mouse">mouse</text>
      <g fill="none" stroke="var(--accent)" stroke-width="1.5">
        <path d="M54 55 a14 14 0 0 1 0 0"><animate attributeName="d" dur="2.4s" repeatCount="indefinite" values="M54 45 a14 14 0 0 1 0 20;M54 40 a20 20 0 0 1 0 30;M54 45 a14 14 0 0 1 0 20" /></path>
        <path d="M70 40 a30 30 0 0 1 0 30"><animate attributeName="opacity" dur="2.4s" repeatCount="indefinite" values="0.3;1;0.3" /></path>
        <path d="M88 30 a48 48 0 0 1 0 50"><animate attributeName="opacity" dur="2.4s" begin="-0.4s" repeatCount="indefinite" values="0.15;0.8;0.15" /></path>
      </g>
      <circle cx="210" cy="55" r="5" fill="none" stroke="var(--violet)" stroke-width="1.5" />
      <text x="210" y="80" text-anchor="middle" font-size="8" fill="var(--text-mut)" data-i18n="tipmedia.longRange.receiver">receiver</text>
    `,
  },
  {
    id: 'mouseAngleMode',
    label: 'Mouse Angle Mode',
    description: 'A diagonal physical move reads as a straight horizontal cursor move',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    svgContent: `
      <text x="8" y="16" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.angleMode.physical">physical movement (-5°)</text>
      <!-- The dashed cross is the *fixed* 0°/90° reference (true horizontal
           and vertical) — it must NOT rotate with the solid line, or it
           stops being a reference for anything. Only the solid accent
           stroke (the actual tilted movement) sits inside the rotated
           group. Both the fixed horizontal dash and the rotated solid line
           are centred on the same pivot (130, 40) — a plain horizontal
           line drawn *at* y=40 necessarily passes through any point that
           has y=40, and rotating a line around a point *on* that same line
           leaves the point fixed — so they cross exactly there regardless
           of the angle, with no special-casing needed. -->
      <line x1="130" y1="15" x2="130" y2="65" stroke="var(--violet)" stroke-width="1" stroke-dasharray="3 2" opacity="0.45" />
      <line x1="0" y1="40" x2="260" y2="40" stroke="var(--violet)" stroke-width="1" stroke-dasharray="3 2" opacity="0.45" />
      <g transform="rotate(-5 130 40)">
        <line x1="0" y1="40" x2="260" y2="40" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" />
        <circle r="4" fill="var(--accent)">
          <animateMotion dur="2.6s" repeatCount="indefinite" path="M0 40 L260 40" />
        </circle>
      </g>
      <text x="8" y="88" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.onScreen">on screen</text>
      <line x1="0" y1="96" x2="260" y2="96" stroke="var(--violet)" stroke-width="2" stroke-linecap="round" />
      <circle r="4" fill="var(--violet)">
        <animateMotion dur="2.6s" repeatCount="indefinite" path="M0 96 L260 96" />
      </circle>
    `,
  },
  {
    id: 'debounce',
    label: 'Key response time',
    description:
      'A press, a burst of contact bounce, the wait window that outlasts it, and the click accepted once it ends clean',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // One button, one press per loop. The signal is revealed left to right by
    // a clipPath whose rect widens at a constant rate (0 -> 260 over the first
    // 60% of the loop) — a clip rather than a stroke-dash reveal because the
    // chatter's vertical spikes would otherwise eat arc length and make the
    // pen crawl through the bounce. The wait window sits inside the same clip,
    // so it grows with the signal, and each label switches on at the moment
    // the reveal reaches its x (t = x / 260 * 0.6): press at 70 -> 0.162,
    // window end at 134 -> 0.309. The clip id is document-global, hence the
    // `deb-` prefix.
    svgContent: `
      <defs>
        <clipPath id="deb-reveal">
          <rect x="0" y="0" width="0" height="110"><animate attributeName="width" dur="3s" repeatCount="indefinite" keyTimes="0;0.6;1" values="0;260;260" /></rect>
        </clipPath>
      </defs>
      <g clip-path="url(#deb-reveal)">
        <!-- the wait window: from the press to the end of the debounce time -->
        <rect x="70" y="28" width="64" height="46" fill="var(--accent)" opacity="0.1" />
        <line x1="134" y1="30" x2="134" y2="74" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 2" opacity="0.7" />
        <!-- released (low) -> press edge -> contact chatter (red) -> settled (high) -->
        <path d="M16 64 H70 V36" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
        <path d="M70 36 H73.5 V64 H76 V36 H80 V64 H82 V36 H87 V64 H88.5 V36 H98" fill="none" stroke="var(--red)" stroke-width="1.6" stroke-linejoin="round" />
        <path d="M98 36 H244" fill="none" stroke="currentColor" stroke-width="1.6" />
      </g>
      <text x="70" y="86" text-anchor="middle" font-size="9" fill="var(--text-mut)" opacity="0" data-i18n="tipmedia.debounce.press">press<animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.162;1" values="0;1;1" /></text>
      <text x="81" y="24" text-anchor="middle" font-size="9" fill="var(--red)" opacity="0" data-i18n="tipmedia.debounce.bounce">contact bounce<animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.19;1" values="0;1;1" /></text>
      <text x="112" y="58" text-anchor="middle" font-size="9" fill="var(--accent)" opacity="0" data-i18n="tipmedia.debounce.wait">wait<animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.22;1" values="0;1;1" /></text>
      <g opacity="0">
        <animate attributeName="opacity" dur="3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.309;1" values="0;1;1" />
        <path d="M127 24 l4 4 l7 -8" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        <text x="142" y="28" font-size="9" fill="var(--accent)" data-i18n="tipmedia.debounce.accepted">accepted</text>
      </g>
    `,
  },
  {
    id: 'dpi',
    label: 'DPI',
    description:
      'One 40 px hand movement moves the cursor a short way at 400 DPI and four times as far at 1600',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // Left, the pad: the mouse slides 40px right and back (a dashed ghost
    // marks where it started). Right, the screen: two cursors leave the same
    // x on the same timing — the 400 one travels 14px, the 1600 one 56px, a
    // 4:1 ratio to match the numbers — each trailing a line so the distance
    // stays readable through the hold. All three share one set of keyTimes
    // and splines, so the cursors read as driven by the hand, not animated on
    // their own.
    svgContent: `
      <rect x="12" y="16" width="104" height="66" rx="6" fill="var(--bg-3)" stroke="var(--line)" />
      <rect x="31" y="38" width="14" height="22" rx="6" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="2 2" opacity="0.35" />
      <g transform="translate(38 49)">
        <g>
          <animateTransform attributeName="transform" type="translate" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.12;0.55;0.8;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="0 0;0 0;40 0;40 0;0 0" />
          <rect x="-7" y="-11" width="14" height="22" rx="6" fill="var(--bg-2)" stroke="currentColor" stroke-width="1.3" />
          <line x1="0" y1="-11" x2="0" y2="-4" stroke="currentColor" stroke-width="1" />
          <rect x="-1.2" y="-8.5" width="2.4" height="4" rx="1" fill="currentColor" />
        </g>
      </g>
      <text x="64" y="98" text-anchor="middle" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.dpi.same">same hand movement</text>
      <rect x="134" y="16" width="114" height="66" rx="4" fill="var(--bg-3)" stroke="var(--line)" />
      <text x="142" y="38" font-size="9" fill="var(--violet)">400</text>
      <rect x="166" y="33.3" width="0" height="1.4" fill="var(--violet)" opacity="0.6"><animate attributeName="width" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.12;0.55;0.8;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="0;0;14;14;0" /></rect>
      <g transform="translate(166 34)">
        <g>
          <animateTransform attributeName="transform" type="translate" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.12;0.55;0.8;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="0 0;0 0;14 0;14 0;0 0" />
          <path d="M0 0 L0 11.5 L3.1 8.8 L5.3 13.4 L7.3 12.5 L5.1 7.9 L8.8 7.9 Z" fill="var(--violet)" />
        </g>
      </g>
      <text x="142" y="66" font-size="9" fill="var(--accent)">1600</text>
      <rect x="166" y="61.3" width="0" height="1.4" fill="var(--accent)" opacity="0.6"><animate attributeName="width" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.12;0.55;0.8;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="0;0;56;56;0" /></rect>
      <g transform="translate(166 62)">
        <g>
          <animateTransform attributeName="transform" type="translate" dur="3s" repeatCount="indefinite" calcMode="spline" keyTimes="0;0.12;0.55;0.8;1" keySplines="0 0 1 1;0.4 0 0.2 1;0 0 1 1;0.4 0 0.2 1" values="0 0;0 0;56 0;56 0;0 0" />
          <path d="M0 0 L0 11.5 L3.1 8.8 L5.3 13.4 L7.3 12.5 L5.1 7.9 L8.8 7.9 Z" fill="var(--accent)" />
        </g>
      </g>
      <text x="191" y="98" text-anchor="middle" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.onScreen">on screen</text>
    `,
  },
  {
    id: 'sleep',
    label: 'Sleep timer',
    description:
      'The idle timer fills, the mouse dims and sleeps; a nudge wakes it and the timer starts over',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // 3.2s loop: the ring fills while the mouse sits still (0 -> 0.55), the
    // mouse dims and "zz" drifts up (0.55 -> 0.68), it sleeps, then at 0.82 a
    // 3px nudge wakes it: opacity back, zz gone, ring emptied and counting
    // again. The ring is seamless across the loop seam — it is already 24%
    // full at t=0 because the count restarted at 0.822 of the previous pass
    // (0.178 / (0.178 + 0.55) of the fill; dashoffset 85.4 of the 113.1
    // circumference). Only opacity, dashoffset, y and a translate animate;
    // the colours are static var() fills (see liftOffDistance for why).
    svgContent: `
      <g>
        <animateTransform attributeName="transform" type="translate" dur="3.2s" repeatCount="indefinite" keyTimes="0;0.82;0.835;0.85;1" values="0 0;0 0;3 0;0 0;0 0" />
        <g>
          <animate attributeName="opacity" dur="3.2s" repeatCount="indefinite" keyTimes="0;0.55;0.62;0.82;0.84;1" values="1;1;0.35;0.35;1;1" />
          <rect x="44" y="27" width="32" height="50" rx="15" fill="var(--bg-3)" stroke="currentColor" stroke-width="1.5" />
          <line x1="60" y1="27" x2="60" y2="48" stroke="currentColor" stroke-width="1" />
          <rect x="58" y="34" width="4" height="8" rx="2" fill="currentColor" />
        </g>
      </g>
      <text x="84" y="30" font-size="10" fill="var(--text-mut)" opacity="0">zz<animate attributeName="opacity" dur="3.2s" repeatCount="indefinite" keyTimes="0;0.58;0.68;0.82;0.86;1" values="0;0;1;1;0;0" /><animate attributeName="y" dur="3.2s" repeatCount="indefinite" keyTimes="0;0.58;0.82;0.821;1" values="30;30;24;30;30" /></text>
      <text x="60" y="96" text-anchor="middle" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.sleep.awake">awake<animate attributeName="opacity" dur="3.2s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.58;0.84;1" values="1;0;1;1" /></text>
      <text x="60" y="96" text-anchor="middle" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.sleep.asleep">asleep<animate attributeName="opacity" dur="3.2s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.58;0.84;1" values="0;1;0;0" /></text>
      <circle cx="164" cy="48" r="18" fill="none" stroke="var(--line)" stroke-width="3" />
      <circle cx="164" cy="48" r="18" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="85.4" transform="rotate(-90 164 48)">
        <animate attributeName="stroke-dashoffset" dur="3.2s" repeatCount="indefinite" keyTimes="0;0.55;0.82;0.822;1" values="85.4;0;0;113.1;85.4" />
        <animate attributeName="opacity" dur="3.2s" repeatCount="indefinite" keyTimes="0;0.55;0.62;0.82;0.84;1" values="1;1;0.4;0.4;1;1" />
      </circle>
      <text x="164" y="84" text-anchor="middle" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.sleep.timer">idle timer</text>
    `,
  },
  {
    id: 'rapidTrigger',
    label: 'Rapid Trigger',
    description:
      'Two identical strokes: without RT the key fires once, with RT it fires on every reversal',
    // NB: kebab-case attributes — parsed as HTML via dangerouslySetInnerHTML.
    //
    // The old illustration was a generic travel squiggle with a dot running
    // along it, which showed neither a threshold nor a keypress — nothing in it
    // was about rapid trigger. This draws the actual difference: the SAME
    // partial-stroke wiggle in both bands, one without RT and one with, so the
    // count of fire markers is the whole point.
    svgContent: `
      <text x="8" y="12" font-size="9" fill="var(--text-mut)" data-i18n="tipmedia.rt.without">without rapid trigger · 1 press</text>
      <!-- actuation threshold for the top trace -->
      <line x1="20" y1="26" x2="252" y2="26" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity="0.7" />
      <path d="M 26 18 L 58 44 L 82 34 L 106 44 L 130 34 L 154 44 L 186 18 L 248 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" opacity="0.75" />
      <!-- Fires once, where it first crosses the line going down. It never
           comes back above the line, so it can never fire again. -->
      <circle cx="33.8" cy="26" r="3.4" fill="var(--accent)" />

      <text x="8" y="68" font-size="9" fill="var(--accent)" data-i18n="tipmedia.rt.with">with rapid trigger · 3 presses</text>
      <line x1="20" y1="82" x2="252" y2="82" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 3" opacity="0.7" />
      <path d="M 26 74 L 58 100 L 82 90 L 106 100 L 130 90 L 154 100 L 186 74 L 248 74" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linejoin="round" />
      <!-- Fires at every reversal downward, deep in the stroke, because the
           threshold is measured from the point the key turned around — not
           from the dashed line. -->
      <circle cx="58" cy="100" r="3.4" fill="var(--accent)" />
      <circle cx="106" cy="100" r="3.4" fill="var(--accent)" />
      <circle cx="154" cy="100" r="3.4" fill="var(--accent)" />
      <!-- and releases at every reversal upward (hollow) -->
      <circle cx="82" cy="90" r="3" fill="none" stroke="var(--violet)" stroke-width="1.4" />
      <circle cx="130" cy="90" r="3" fill="none" stroke="var(--violet)" stroke-width="1.4" />

      <!-- One dot per trace, in step, so the two read as the same stroke. -->
      <circle r="2.6" fill="var(--text-mut)">
        <animateMotion dur="3.2s" repeatCount="indefinite" path="M 26 18 L 58 44 L 82 34 L 106 44 L 130 34 L 154 44 L 186 18 L 248 18" />
      </circle>
      <circle r="2.6" fill="var(--text-mut)">
        <animateMotion dur="3.2s" repeatCount="indefinite" path="M 26 74 L 58 100 L 82 90 L 106 100 L 130 90 L 154 100 L 186 74 L 248 74" />
      </circle>
    `,
  },
  {
    id: 'actuationPoint',
    label: 'Actuation point',
    description: 'The depth at which a key registers — the gauge lights up only past it',
    // The release line is gone: this tooltip is about ONE threshold, and a
    // second dashed line next to it invited exactly the "which is which"
    // confusion. Release has its own control and its own tooltip.
    //
    // The bar changes colour the instant it passes the line and goes back to
    // grey on the way up, which is the thing "actuation" actually means and
    // which a uniformly-coloured growing bar never conveyed.
    //
    // Two stacked rects share one height animation; only the ACCENT one has
    // its opacity switched. That is deliberate — SMIL cannot animate to a CSS
    // custom property in Chromium (see liftOffDistance below), so the colour
    // lives in a static `fill` and only opacity is animated. calcMode
    // "discrete" makes it a snap rather than a fade.
    //
    // The keyTimes are solved against the height animation, not guessed: the
    // bar runs 14 -> 58 over the first 45% of the loop, and the actuation line
    // sits at height 28, so it is crossed at 0.45 * (28-14)/(58-14) = 0.143 on
    // the way down and, by the same arithmetic on the return leg, 0.857 on the
    // way back up.
    svgContent: `
      <rect x="60" y="14" width="40" height="82" rx="4" fill="var(--bg-2)" stroke="var(--line)" />
      <!-- grey bar: always present -->
      <rect x="64" y="18" width="32" height="14" rx="3" fill="var(--text-mut)">
        <animate attributeName="height" dur="2.6s" repeatCount="indefinite" keyTimes="0;0.45;0.55;1" values="14;58;58;14" />
      </rect>
      <!-- accent bar: identical, revealed only while past the line -->
      <rect x="64" y="18" width="32" height="14" rx="3" fill="var(--accent)" opacity="0">
        <animate attributeName="height" dur="2.6s" repeatCount="indefinite" keyTimes="0;0.45;0.55;1" values="14;58;58;14" />
        <animate attributeName="opacity" dur="2.6s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.143;0.857;1" values="0;1;0;0" />
      </rect>
      <line x1="52" y1="46" x2="150" y2="46" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 3" />
      <text x="156" y="43" font-size="9" fill="var(--accent)" data-i18n="tipmedia.actuation.point">actuation point</text>
      <text x="156" y="56" font-size="8" fill="var(--text-mut)" data-i18n="tipmedia.actuation.past">lights up past here</text>
    `,
  },
  {
    id: 'globalActuation',
    label: 'Global actuation',
    description: 'Applies one actuation depth to every key at once',
    svgContent: `
      <g fill="var(--bg-2)" stroke="var(--line)">
        <rect x="20" y="24" width="26" height="26" rx="3" /><rect x="52" y="24" width="26" height="26" rx="3" /><rect x="84" y="24" width="26" height="26" rx="3" />
        <rect x="116" y="24" width="26" height="26" rx="3" /><rect x="148" y="24" width="26" height="26" rx="3" /><rect x="180" y="24" width="26" height="26" rx="3" /><rect x="212" y="24" width="26" height="26" rx="3" />
      </g>
      <g fill="var(--accent)">
        <rect x="20" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" repeatCount="indefinite" values="8;20;8" /></rect>
        <rect x="52" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" begin="-0.1s" repeatCount="indefinite" values="8;20;8" /></rect>
        <rect x="84" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" begin="-0.2s" repeatCount="indefinite" values="8;20;8" /></rect>
        <rect x="116" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" begin="-0.3s" repeatCount="indefinite" values="8;20;8" /></rect>
        <rect x="148" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" begin="-0.4s" repeatCount="indefinite" values="8;20;8" /></rect>
        <rect x="180" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" begin="-0.5s" repeatCount="indefinite" values="8;20;8" /></rect>
        <rect x="212" y="24" width="26" height="8" rx="3"><animate attributeName="height" dur="2.2s" begin="-0.6s" repeatCount="indefinite" values="8;20;8" /></rect>
      </g>
      <text x="130" y="78" text-anchor="middle" font-size="8" fill="var(--text-mut)" data-i18n="tipmedia.global.oneDepth">one depth, every key</text>
    `,
  },
  {
    id: 'topDeadZone',
    label: 'Top dead zone',
    description: 'Travel at the very top that is ignored entirely',
    svgContent: `
      <rect x="90" y="14" width="60" height="86" rx="4" fill="var(--bg-2)" stroke="var(--line)" />
      <rect x="90" y="14" width="60" height="18" fill="url(#tdz-hatch)" opacity="0.6" />
      <defs><pattern id="tdz-hatch" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 7 L7 0" stroke="var(--text-mut)" stroke-width="1" /></pattern></defs>
      <line x1="82" y1="32" x2="170" y2="32" stroke="var(--accent)" stroke-width="1.5" />
      <text x="176" y="35" font-size="9" fill="var(--accent)" data-i18n="tipmedia.dz.ends">dead zone ends</text>
      <circle cx="120" cy="22" r="4" fill="var(--text-mut)">
        <animate attributeName="cy" dur="2.4s" repeatCount="indefinite" values="18;30;18" />
      </circle>
    `,
  },
  {
    id: 'bottomDeadZone',
    label: 'Bottom dead zone',
    description: 'Travel at the very bottom of the stroke that is ignored entirely',
    svgContent: `
      <rect x="90" y="14" width="60" height="86" rx="4" fill="var(--bg-2)" stroke="var(--line)" />
      <rect x="90" y="82" width="60" height="18" fill="url(#bdz-hatch)" opacity="0.6" />
      <defs><pattern id="bdz-hatch" width="7" height="7" patternUnits="userSpaceOnUse"><path d="M0 7 L7 0" stroke="var(--text-mut)" stroke-width="1" /></pattern></defs>
      <line x1="82" y1="82" x2="170" y2="82" stroke="var(--accent)" stroke-width="1.5" />
      <text x="176" y="85" font-size="9" fill="var(--accent)" data-i18n="tipmedia.dz.starts">dead zone starts</text>
      <circle cx="120" cy="92" r="4" fill="var(--text-mut)">
        <animate attributeName="cy" dur="2.4s" repeatCount="indefinite" values="96;84;96" />
      </circle>
    `,
  },
];
