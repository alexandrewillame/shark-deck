import { describe, expect, it } from 'vitest';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { KB_FACTORY_RELEASE_MM, KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import { groupingSignature, isFactoryDefault, mixedFields } from './magneticSelection';

const k = (over: Partial<MagneticKeySettings> = {}): MagneticKeySettings =>
  ({
    row: 0,
    col: 0,
    actuationMm: 2.0,
    releaseMm: 2.0,
    deadZoneMm: 0.3,
    deadZoneBottomMm: 0.3,
    rapidTrigger: false,
    mode: 'normal',
    ...over,
  }) as MagneticKeySettings;

describe('mixedFields', () => {
  it('reports nothing for a single key', () => {
    // One key can never disagree with itself, and a lone selection must show
    // its real values.
    expect(mixedFields([k({ actuationMm: 1.2 })])).toEqual({});
    expect(mixedFields([])).toEqual({});
  });

  it('reports nothing when the selection already agrees', () => {
    const m = mixedFields([k(), k(), k()]);
    expect(m.actuationMm).toBe(false);
    expect(m.mode).toBe(false);
  });

  it('flags only the settings that differ', () => {
    const m = mixedFields([k({ actuationMm: 1.2 }), k({ actuationMm: 2.8 })]);
    expect(m.actuationMm).toBe(true);
    expect(m.deadZoneMm, 'shared values stay shown').toBe(false);
  });

  it('flags non-numeric settings too', () => {
    const m = mixedFields([k({ mode: 'normal' }), k({ mode: 'snap' })]);
    expect(m.mode).toBe(true);
    const rt = mixedFields([k({ rapidTrigger: true }), k({ rapidTrigger: false })]);
    expect(rt.rapidTrigger).toBe(true);
  });

  it('treats an unset value as different from a set one', () => {
    // A key read before rapid trigger existed carries `undefined`, which is
    // not the same as 0.2 mm and must not be drawn as if it were.
    const m = mixedFields([k({ rtPressMm: undefined }), k({ rtPressMm: 0.2 })]);
    expect(m.rtPressMm).toBe(true);
  });
});

/**
 * Two keys are one group exactly when their signatures match — so the
 * signature must ignore a stored value that is not in force, or a Reset key
 * (RT off, sensitivity 0.2 remembered) and an untouched key (RT off, RT page
 * empty) are two groups for nothing.
 */
describe('groupingSignature', () => {
  it('is the same for identical keys and differs on any setting in force', () => {
    expect(groupingSignature(k())).toBe(groupingSignature(k()));
    expect(groupingSignature(k({ actuationMm: 1.5 }))).not.toBe(groupingSignature(k()));
    expect(groupingSignature(k({ mode: 'snap' }))).not.toBe(groupingSignature(k()));
    expect(groupingSignature(k({ rapidTrigger: true }))).not.toBe(groupingSignature(k()));
    expect(groupingSignature(k({ deadZoneBottomMm: 0 }))).not.toBe(groupingSignature(k()));
  });

  it('ignores the rapid-trigger sensitivities while rapid trigger is off', () => {
    // The reported split: keys the app had Reset (0.2 stored) sat in a
    // different group from keys that had never been touched (page empty).
    expect(groupingSignature(k({ rtPressMm: 0.2, rtReleaseMm: 0.2 }))).toBe(
      groupingSignature(k({ rtPressMm: undefined, rtReleaseMm: undefined })),
    );
  });

  it('keeps the sensitivities once rapid trigger is on', () => {
    const on = { rapidTrigger: true } as const;
    expect(groupingSignature(k({ ...on, rtPressMm: 0.2 }))).not.toBe(
      groupingSignature(k({ ...on, rtPressMm: 0.5 })),
    );
    expect(groupingSignature(k({ ...on, rtPressMm: 0.2 }))).toBe(
      groupingSignature(k({ ...on, rtPressMm: 0.2 })),
    );
  });

  it('ignores the mod-tap hold outside mod-tap, and keeps it inside', () => {
    expect(groupingSignature(k({ mtHoldMs: 200 }))).toBe(groupingSignature(k({ mtHoldMs: 350 })));
    expect(groupingSignature(k({ mode: 'mt', mtHoldMs: 200 }))).not.toBe(
      groupingSignature(k({ mode: 'mt', mtHoldMs: 350 })),
    );
  });

  it('does not split a group on float noise', () => {
    // 2.5 - 0.5 is 2 in arithmetic and 1.9999999999999998 in binary.
    expect(groupingSignature(k({ actuationMm: 2.5 - 0.5 }))).toBe(
      groupingSignature(k({ actuationMm: 2 })),
    );
    // ...while a real difference of one slider step still counts.
    expect(groupingSignature(k({ actuationMm: 2.01 }))).not.toBe(
      groupingSignature(k({ actuationMm: 2 })),
    );
  });
});

/**
 * The Default group is the keys at the FACTORY settings — which is not one
 * set of numbers: an untouched key and a key the app has Reset differ on the
 * release page and the dead-zone pages, and both must count.
 */
describe('isFactoryDefault', () => {
  const T = KB_TRAVEL_RANGE;

  it('accepts what Reset writes', () => {
    expect(
      isFactoryDefault(
        k({
          actuationMm: T.travel.default,
          releaseMm: T.travel.default,
          rtPressMm: T.rt.default,
          rtReleaseMm: T.rt.default,
          deadZoneMm: T.deadzone.default,
          deadZoneBottomMm: T.deadzone.default,
        }),
      ),
    ).toBe(true);
  });

  it('accepts what an untouched R85HE reads', () => {
    // Press 2.0, release 2.8, bottom dead zone 0.3, top dead-zone page all
    // zeros, RT page empty — docs/protocol/keyboard-compx.md.
    expect(
      isFactoryDefault(
        k({
          actuationMm: 2.0,
          releaseMm: KB_FACTORY_RELEASE_MM,
          deadZoneMm: 0,
          deadZoneBottomMm: 0.3,
          rtPressMm: undefined,
          rtReleaseMm: undefined,
        }),
      ),
    ).toBe(true);
  });

  it('accepts a key whose dead-zone or release pages were not reported', () => {
    expect(
      isFactoryDefault(
        k({ releaseMm: undefined, deadZoneMm: undefined, deadZoneBottomMm: undefined }),
      ),
    ).toBe(true);
  });

  it('rejects the old 2.5 mm table default', () => {
    expect(isFactoryDefault(k({ actuationMm: 2.5, releaseMm: 2.5 }))).toBe(false);
  });

  it('rejects any setting that has been changed', () => {
    expect(isFactoryDefault(k({ rapidTrigger: true }))).toBe(false);
    expect(isFactoryDefault(k({ mode: 'snap' }))).toBe(false);
    expect(isFactoryDefault(k({ mode: 'dks' }))).toBe(false);
    expect(isFactoryDefault(k({ actuationMm: 1.5 }))).toBe(false);
    expect(isFactoryDefault(k({ releaseMm: 1.5 }))).toBe(false);
    expect(isFactoryDefault(k({ deadZoneMm: 0.5 }))).toBe(false);
    expect(isFactoryDefault(k({ deadZoneBottomMm: 0 }))).toBe(false);
    expect(isFactoryDefault(k({ deadZoneBottomMm: 0.5 }))).toBe(false);
  });

  it('ignores a stored RT sensitivity or mod-tap hold that is not in force', () => {
    expect(isFactoryDefault(k({ rtPressMm: 0.7, rtReleaseMm: 0.9 }))).toBe(true);
    expect(isFactoryDefault(k({ mtHoldMs: 500 }))).toBe(true);
  });

  it('tolerates float noise but not a slider step', () => {
    expect(isFactoryDefault(k({ actuationMm: 2.5 - 0.5, releaseMm: 2.5 - 0.5 }))).toBe(true);
    expect(isFactoryDefault(k({ actuationMm: 2.01 }))).toBe(false);
  });
});
