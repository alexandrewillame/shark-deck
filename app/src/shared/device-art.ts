import manifest from '../../assets/devices/manifest.json';
import type { DeviceColorVariant, DeviceDescriptor } from './types/device';

/**
 * The product photos: `app/assets/devices/manifest.json`, one entry per
 * marketing model (its "art key"), one variant per colour the official store
 * sells. Written by `scripts/build-device-art.py`, signed off by the user
 * before it ships. Shared by the main process (which colours a device offers,
 * which one it starts on) and the renderer (deviceArtAssets.ts, which bundles
 * the files).
 */

interface ManifestVariant {
  colour: string;
  file: string;
}
interface ManifestModel {
  kind: 'mouse' | 'keyboard';
  name: string;
  variants: Record<string, ManifestVariant>;
}
const MODELS = (manifest as unknown as { models: Record<string, ManifestModel> }).models;
const SWATCHES = (manifest as unknown as { swatches: Record<string, string> }).swatches;

/**
 * Store colour names with a translated label. Every other name (Ice Ninja,
 * Knight-Errant, White Contours…) is an edition name and shown as the store
 * writes it, the way a product name would be.
 */
export const COLOUR_KEYS: Readonly<Record<string, string>> = {
  Black: 'color.black',
  White: 'color.white',
  Red: 'color.red',
  Grey: 'color.grey',
  Purple: 'color.purple',
  Blue: 'color.blue',
  Green: 'color.green',
  Pink: 'color.pink',
  Orange: 'color.orange',
  Yellow: 'color.yellow',
  Silver: 'color.silver',
  'Berry Red': 'color.berryRed',
  'Rose Red': 'color.roseRed',
  Lavender: 'color.lavender',
  'White & Black': 'color.whiteBlack',
  'Purple & Blue': 'color.purpleBlue',
  'Purple Blue': 'color.purpleBlue',
};

/** The photo set a model shows: several firmware ids often share one. */
export const artKeyOf = (d: Pick<DeviceDescriptor, 'artKey' | 'model'>): string =>
  d.artKey ?? d.model;

/** The colours an art key has photos for, as the picker shows them. */
export function artVariants(artKey: string): DeviceColorVariant[] {
  const m = MODELS[artKey];
  if (!m) return [];
  return Object.entries(m.variants).map(([id, v]) => ({
    id,
    ...(COLOUR_KEYS[v.colour] ? { labelKey: COLOUR_KEYS[v.colour] } : { label: v.colour }),
    swatch: SWATCHES[v.colour] ?? '#8a8f98',
  }));
}

/**
 * A device's colours: a hand-written list wins (the V8's and the R85HE's,
 * whose ids users already have stored), else the photos its art key has.
 */
export function colorVariantsOf(
  d: Pick<DeviceDescriptor, 'colorVariants' | 'artKey' | 'model'>,
): DeviceColorVariant[] {
  return d.colorVariants?.length ? d.colorVariants : artVariants(artKeyOf(d));
}

/** Every photo file the manifest names, with where it belongs. */
export function artFiles(): { artKey: string; variantId: string; file: string }[] {
  return Object.entries(MODELS).flatMap(([artKey, m]) =>
    Object.entries(m.variants).map(([variantId, v]) => ({ artKey, variantId, file: v.file })),
  );
}

/** The art keys the manifest has, for the tests. */
export const ART_KEYS: readonly string[] = Object.keys(MODELS);
