import { artFiles } from '@shared/device-art';

/**
 * Every device photo, bundled by Vite so it loads same-origin under the strict
 * `img-src 'self' data: blob:` CSP — a runtime path into app/assets/ would
 * fight that CSP from the sandboxed renderer. The files live in the top-level
 * app/assets/devices/ (see that folder's README), outside the renderer root;
 * an eager `import.meta.glob` is a module-graph import like a static one, so
 * Vite resolves it at build time. If the dev server ever 404s here, add
 * `renderer.server.fs.allow` in electron.vite.config.ts rather than moving
 * the images.
 *
 * Every file in the folder is bundled — and the browser edition precaches
 * every bundled file — so the folder holds only what the manifest and the
 * detail shots below name (deviceArt.test.ts fails on a stray file, and
 * src/web/precacheBudget.test.ts on the total).
 */
const URLS = import.meta.glob('../../../assets/devices/*.{webp,png}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** A bundled file's URL, by its name in app/assets/devices/. */
export const artUrl = (file: string): string | undefined => URLS[`../../../assets/devices/${file}`];

/**
 * art key (shared/device-art.ts — `DeviceUi.artKey`) -> colour variant id ->
 * bundled image URL, from app/assets/devices/manifest.json. One art key can
 * serve several firmware ids (the X68 HE is three), so photos are never keyed
 * by model slug; a colour pick still is (devices/colors.ts).
 */
export const DEVICE_ART: Record<string, Record<string, string>> = {};
for (const { artKey, variantId, file } of artFiles()) {
  const url = artUrl(file);
  if (url) (DEVICE_ART[artKey] ??= {})[variantId] = url;
}

/**
 * A close-up detail shot shown beside a device's main hero photo — the
 * mouse's Lighting tab Receiver LED / DPI-indicator LED sub-panes, and the
 * keyboard's Lighting tab Side pane (see tabs/LightingTab.tsx and HeroPane's
 * `detail` prop in tabs/common.tsx) — a plain, non-colour-variant image, so
 * it's keyed by art key only, not variant.
 */
export const DEVICE_ART_DETAIL: Record<
  string,
  { receiverLed?: string; dpiLed?: string; sideLight?: string }
> = {
  'attack-shark-v8': {
    receiverLed: artUrl('attack-shark-v8-dpi-receiver-led.webp'),
    dpiLed: artUrl('attack-shark-v8-dpi-indicator-led.webp'),
  },
  // The R85HE's files predate the manifest's naming: `r85-he`, not `r85he`.
  'attack-shark-r85he': {
    sideLight: artUrl('attack-shark-r85-he-side-light.webp'),
  },
};
