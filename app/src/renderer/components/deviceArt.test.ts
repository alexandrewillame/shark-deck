import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../main/devices/catalog';
import { DEVICE_ART } from './deviceArtAssets';
import { resolveDeviceArt } from './DeviceArt';

/**
 * A device attaches with `colorVariant` defaulted to its catalogue's *first*
 * variant (devices/manager.ts's newLiveDevice) — that default is the only
 * reason a freshly-plugged V8 or R85 HE shows its product photo instead of the
 * generic silhouette, since every descriptor leaves the legacy `art` field
 * null. It only works if that first variant id actually has a bundled image,
 * so a model whose swatch list and art map drift apart fails here rather than
 * silently falling back to the silhouette in the app.
 */
describe('the catalogue default colour variant resolves to a real photo', () => {
  const withVariants = CATALOG.filter((d) => (d.colorVariants?.length ?? 0) > 0);

  it('covers the models that ship art', () => {
    // Deduped: the V8 has two descriptors (dongle and USB-C) sharing one
    // model, because they are one mouse with one set of photos.
    expect([...new Set(withVariants.map((d) => d.model))].sort()).toEqual([
      'attack-shark-r85he',
      'attack-shark-v8',
    ]);
  });

  for (const d of withVariants) {
    it(`${d.model} resolves art for every declared variant, default first`, () => {
      const first = d.colorVariants![0]!.id;
      expect(resolveDeviceArt(d.model, first, d.art), `${d.model}/${first}`).toBeTruthy();
      for (const v of d.colorVariants!) {
        expect(DEVICE_ART[d.model]?.[v.id], `${d.model}/${v.id}`).toBeTruthy();
      }
    });
  }
});
