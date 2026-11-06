import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/device';
import { ART_KEYS, artFiles, artKeyOf, colorVariantsOf } from '@shared/device-art';
import { CATALOG } from '../../main/devices/catalog';
import { KEYBOARDS } from '../../main/devices/catalog/keyboards';
import { KEYBOARD_ART } from '../../main/devices/catalog/keyboard-builder';
import { HUB_CANDIDATES, hubMouseRoster } from '../../main/devices/catalog/hub-mice';
import { GEARHUB_MICE } from '../../main/devices/catalog/gearhub-mice';
import { jxcMouseRoster } from '../../main/devices/catalog/jxc-mice';
import { bekenDescriptorFor } from '../../main/devices/catalog/beken-mice';
import { DEVICE_ART, DEVICE_ART_DETAIL } from './deviceArtAssets';
import { resolveDeviceArt } from './DeviceArt';

/**
 * The product photos (app/assets/devices/, named by manifest.json) against the
 * catalogues that show them. A device attaches with `colorVariant` defaulted
 * to its first colour (devices/manager.ts), and that default is the only
 * reason a card shows a photo instead of the generic silhouette — so every
 * model that names a photo set must resolve one, default first.
 */
const DIR = resolve(__dirname, '../../../assets/devices');
const manifest = JSON.parse(readFileSync(resolve(DIR, 'manifest.json'), 'utf8')) as {
  swatches: Record<string, string>;
  models: Record<
    string,
    { variants: Record<string, { colour: string; src: string | null; file: string }> }
  >;
};

/** Every descriptor Shark Deck can show, from every catalogue. */
const ALL: DeviceDescriptor[] = [
  ...CATALOG,
  ...KEYBOARDS,
  ...hubMouseRoster(),
  ...GEARHUB_MICE.values(),
  ...jxcMouseRoster(),
  ...[0xfa55, 0x2126, 0x2111, 0x2124].map((pid) => bekenDescriptorFor(pid)!),
];

describe('the photo files', () => {
  it('exist for every variant the manifest names', () => {
    for (const { artKey, variantId, file } of artFiles()) {
      expect(existsSync(resolve(DIR, file)), `${artKey}/${variantId}: ${file}`).toBe(true);
    }
  });

  it('stay under 50 KB when the pipeline built them', () => {
    for (const [key, m] of Object.entries(manifest.models)) {
      for (const [id, v] of Object.entries(m.variants)) {
        if (v.src === null) continue; // art that predates the pipeline
        expect(statSync(resolve(DIR, v.file)).size, `${key}/${id}`).toBeLessThanOrEqual(50 * 1024);
      }
    }
  });

  it('are all named somewhere — the folder is bundled, and precached, whole', () => {
    const named = new Set(artFiles().map((f) => f.file));
    const details = new Set(
      Object.values(DEVICE_ART_DETAIL)
        .flatMap((d) => Object.values(d))
        .filter(Boolean),
    );
    const stray = readdirSync(DIR)
      .filter((f) => /\.(webp|png)$/.test(f))
      .filter((f) => !named.has(f))
      // a detail shot is named by its bundled URL, which ends in the file name
      .filter((f) => ![...details].some((url) => url!.includes(f.replace(/\.(webp|png)$/, ''))))
      // the R6's LED close-ups wait for its lighting support
      .filter((f) => !f.startsWith('attack-shark-r6-dpi-'));
    expect(stray).toEqual([]);
  });

  it('give every colour name a swatch', () => {
    for (const m of Object.values(manifest.models)) {
      for (const v of Object.values(m.variants))
        expect(manifest.swatches, v.colour).toHaveProperty(v.colour);
    }
  });
});

describe('every model that names a photo set', () => {
  it('names one the manifest has', () => {
    const keys = new Set(ART_KEYS);
    for (const d of ALL)
      if (d.artKey) expect(keys.has(d.artKey), `${d.model} -> ${d.artKey}`).toBe(true);
    for (const key of Object.values(KEYBOARD_ART)) expect(keys.has(key), key).toBe(true);
    for (const models of Object.values(HUB_CANDIDATES)) {
      for (const m of models) expect(keys.has(m.artKey), m.artKey).toBe(true);
    }
  });

  it('resolves a photo for every colour it offers, its default first', () => {
    let withPhotos = 0;
    for (const d of ALL) {
      const variants = colorVariantsOf(d);
      if (!variants.length) continue;
      withPhotos++;
      const key = artKeyOf(d);
      expect(
        resolveDeviceArt(key, variants[0]!.id, d.art),
        `${d.model}/${variants[0]!.id}`,
      ).toBeTruthy();
      for (const v of variants) expect(DEVICE_ART[key]?.[v.id], `${d.model}/${v.id}`).toBeTruthy();
    }
    // non-vacuity: the lineup has photos for most of what Shark Deck drives
    expect(withPhotos).toBeGreaterThan(40);
  });

  it('keeps the colour ids users already have stored for the V8 and the R85HE', () => {
    expect(
      colorVariantsOf(CATALOG.find((d) => d.model === 'attack-shark-v8')!).map((v) => v.id),
    ).toEqual(['black', 'white']);
    expect(
      colorVariantsOf(CATALOG.find((d) => d.model === 'attack-shark-r85he')!).map((v) => v.id),
    ).toEqual(['green', 'black-gradient', 'white', 'white-contour']);
  });

  it('labels a plain colour by a translation and an edition by its own name', () => {
    const r86 = KEYBOARDS.find((d) => d.artKey === 'attack-shark-r86-he')!;
    const variants = colorVariantsOf(r86);
    expect(variants.find((v) => v.id === 'ice-ninja' || v.label === 'Ice Ninja')?.label).toBe(
      'Ice Ninja',
    );
    const r2 = colorVariantsOf(GEARHUB_MICE.get(1893)!); // Grey, Black, White…
    expect(r2.find((v) => v.labelKey === 'color.black')).toBeTruthy();
  });
});
