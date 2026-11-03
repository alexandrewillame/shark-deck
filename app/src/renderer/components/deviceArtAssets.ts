// Static imports so Vite bundles/hashes these into the renderer build and
// they load same-origin (no change needed to the strict `img-src 'self'
// data: blob:` CSP) — a plain runtime path into app/assets/ would fight
// that CSP from the sandboxed renderer. The files live under the top-level
// app/assets/devices/ (see that folder's README), one level outside this
// package's own src/renderer/ — Vite still resolves and bundles a static
// `import` of a path outside its configured root at build time; this is a
// module-graph import, not a dev-server raw-path fetch, which is the case
// `server.fs.allow` restricts. If the dev server ever 404s here, add
// `renderer.server.fs.allow` in electron.vite.config.ts rather than moving
// the images.
import v8Black from '../../../assets/devices/attack-shark-v8-black.webp';
import v8White from '../../../assets/devices/attack-shark-v8-white.webp';
import r85heGreen from '../../../assets/devices/attack-shark-r85-he-green.webp';
import r85heBlackGradient from '../../../assets/devices/attack-shark-r85-he-key-gradient.webp';
import r85heWhite from '../../../assets/devices/attack-shark-r85-he-white.webp';
import r85heWhiteContour from '../../../assets/devices/attack-shark-r85-he-white-contour.webp';
import v8ReceiverLed from '../../../assets/devices/attack-shark-v8-dpi-receiver-led.png';
import v8DpiLed from '../../../assets/devices/attack-shark-v8-dpi-indicator-led.webp';
import r85heSideLight from '../../../assets/devices/attack-shark-r85-he-side-light.webp';

/**
 * model -> variant id (DeviceColorVariant.id, declared in the model's
 * catalog entry under main/devices/catalog/) -> bundled image URL.
 *
 * Note the R85HE's on-disk filenames don't match its `model` slug
 * (`attack-shark-r85he`, no hyphen between "r85" and "he") — they were
 * dropped in as `attack-shark-r85-he-*.webp`. Kept verbatim here rather than
 * renamed, so this map is the one place that translates between the two.
 */
export const DEVICE_ART: Record<string, Record<string, string>> = {
  'attack-shark-v8': {
    black: v8Black,
    white: v8White,
  },
  'attack-shark-r85he': {
    green: r85heGreen,
    'black-gradient': r85heBlackGradient,
    white: r85heWhite,
    'white-contour': r85heWhiteContour,
  },
};

/**
 * A close-up detail shot shown beside a device's main hero photo — the
 * mouse's Lighting tab Receiver LED / DPI-indicator LED sub-panes, and the
 * keyboard's Lighting tab Side pane (see tabs/LightingTab.tsx and HeroPane's
 * `detail` prop in tabs/common.tsx) — a plain, non-colour-variant image, so
 * it's keyed by model only, not variant.
 */
export const DEVICE_ART_DETAIL: Record<
  string,
  { receiverLed?: string; dpiLed?: string; sideLight?: string }
> = {
  'attack-shark-v8': {
    receiverLed: v8ReceiverLed,
    dpiLed: v8DpiLed,
  },
  // Note: the R85HE's on-disk filenames don't match its `model` slug (see
  // DEVICE_ART's own comment above) — kept verbatim here too.
  'attack-shark-r85he': {
    sideLight: r85heSideLight,
  },
};
