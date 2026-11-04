import { describe, expect, it } from 'vitest';
import { ATTACK_SHARK_R85HE } from './catalog/r85he';
import { ATTACK_SHARK_V8, ATTACK_SHARK_V8_WIRED } from './catalog/v8';
import { CATALOG } from './catalog';
import {
  genericCompxKeyboard,
  genericCompxMouse,
  hidRequestFilters,
  knownVendorIds,
  modelIdConflicts,
  resolveDescriptor,
  resolveModelId,
} from './registry';

/**
 * VID/PID does not identify a ROYUAN keyboard. ~99 models share
 * `0x3151:0x5029`; the vendor tools disambiguate on the model id in the
 * `GET_USB_VERSION` reply. Since every per-key magnetic/lighting/remap write is
 * addressed by matrix `slot`, resolving to the wrong model means writing to the
 * wrong keys — so this is a correctness guard, not a cosmetic one.
 *
 * Known ids: R85HE 3123 (verified from hardware), R86PROHE 2793 (0x5030,
 * screen variant) and 2982 (0x5029) — both `Common89_SG8967`, neither modelled
 * yet.
 */
const R86PROHE_ID = 2982;

describe('resolveDescriptor (VID/PID)', () => {
  it('resolves the R85HE exactly', () => {
    expect(resolveDescriptor(0x3151, 0x5029)?.model).toBe(ATTACK_SHARK_R85HE.model);
  });

  it('resolves an unknown-but-known-PID Compx keyboard generically', () => {
    // 0x5030 is in COMPX_VENDOR_CONFIG_PIDS but has no catalogue entry
    expect(resolveDescriptor(0x3151, 0x5030)?.model).toBe(genericCompxKeyboard(0x5030).model);
  });

  it('returns null for an unrelated device', () => {
    expect(resolveDescriptor(0x1234, 0x5678)).toBeNull();
  });

  /**
   * The V8 has two endpoints on the SAME vendor id — 0xF517 through its 8K
   * dongle and 0xF515 over USB-C (confirmed on hardware, same serial, same
   * vendor collection, same protocol). Before the wired entry existed, the
   * cabled mouse fell through to `genericCompxMouse` and showed up as an
   * unnamed "Attack Shark Mouse" that claimed to be wireless.
   */
  it('resolves both V8 endpoints to the V8, not to a generic mouse', () => {
    for (const pid of [0xf517, 0xf515]) {
      const d = resolveDescriptor(0x3554, pid)!;
      expect(d, pid.toString(16)).not.toBeNull();
      expect(d.provenance).toBe('verified-capture');
      expect(d.displayName).toBe('Attack Shark V8');
      // One model string across both, so the per-model stores (profile names,
      // colour pick, backups) follow the mouse rather than the cable.
      expect(d.model).toBe(ATTACK_SHARK_V8.model);
      expect(d.pid).toBe(pid);
    }
    expect(ATTACK_SHARK_V8_WIRED.pid).toBe(0xf515);
  });

  it('marks only the USB-C endpoint as wired', () => {
    expect(resolveDescriptor(0x3554, 0xf517)?.wired).toBeUndefined();
    expect(resolveDescriptor(0x3554, 0xf515)?.wired).toBe(true);
  });

  it('drops the receiver-only capabilities from the wired variant', () => {
    // No dongle attached means nothing to pair with, no receiver LEDs to set
    // and no RF long-range mode.
    const wired = resolveDescriptor(0x3554, 0xf515)!;
    for (const cap of ['receiverLed', 'pairing', 'longDistanceMode'] as const) {
      expect(wired.capabilities, cap).not.toContain(cap);
      expect(ATTACK_SHARK_V8.capabilities, cap).toContain(cap);
    }
    // …but it is still the same mouse otherwise.
    for (const cap of ['dpi', 'pollRate', 'dpiIndicatorLed', 'buttonRemap', 'macros'] as const) {
      expect(wired.capabilities, cap).toContain(cap);
    }
  });

  it('still falls back to a generic mouse for an unknown PID on the dongle vendor', () => {
    expect(resolveDescriptor(0x3554, 0x1234)?.provenance).toBe('inferred');
  });
});

describe('resolveModelId', () => {
  it('leaves a descriptor alone when the id already matches', () => {
    expect(resolveModelId(ATTACK_SHARK_R85HE, 3123)).toBeNull();
  });

  it('ignores a zero / unread model id', () => {
    expect(resolveModelId(ATTACK_SHARK_R85HE, 0)).toBeNull();
  });

  it('ignores the 0xFFFFFFFF "unknown" sentinel', () => {
    expect(resolveModelId(ATTACK_SHARK_R85HE, 0xffffffff)).toBeNull();
  });

  it('does not invent a descriptor for a model we do not carry', () => {
    // An R86PROHE shares the R85HE's PID. We have no descriptor for it, so
    // there is nothing to switch to — but it must be reported as a conflict
    // rather than silently keeping the R85HE's 79-key layout.
    expect(resolveModelId(ATTACK_SHARK_R85HE, R86PROHE_ID)).toBeNull();
    expect(modelIdConflicts(ATTACK_SHARK_R85HE, R86PROHE_ID)).toBe(true);
  });

  it('does not flag a conflict for a descriptor with no known model id', () => {
    // The generic fallback never claims an id, so any device may legitimately
    // be wearing it.
    expect(modelIdConflicts(genericCompxKeyboard(0x5030), R86PROHE_ID)).toBe(false);
  });

  it('does not flag a conflict when the id matches', () => {
    expect(modelIdConflicts(ATTACK_SHARK_R85HE, 3123)).toBe(false);
  });
});

describe('the R85HE descriptor', () => {
  it('carries the model id its firmware actually reports', () => {
    // 0x0c33, read off a real R85HE (fw v5.11) — see
    // docs/reverse-engineering/r85he-identify.json
    expect(ATTACK_SHARK_R85HE.modelId).toBe(0x0c33);
  });
});

describe('hidRequestFilters (the browser edition device picker)', () => {
  const filters = hidRequestFilters();
  const covers = (vid: number, page: number) =>
    filters.some((f) => f.vendorId === vid && f.usagePage === page);

  it('offers every catalog model by vendor id and config usage page', () => {
    for (const d of CATALOG) expect(covers(d.vid, d.usagePage), d.model).toBe(true);
  });

  it('offers the generic families for any product id', () => {
    for (const pid of [0x0001, 0x5555, 0xfffe]) {
      for (const d of [genericCompxKeyboard(pid), genericCompxMouse(pid)]) {
        expect(covers(d.vid, d.usagePage), d.model).toBe(true);
      }
    }
  });

  it('asks only for vendor-defined pages, from vendors the scan enumerates, without repeats', () => {
    const vids = new Set(knownVendorIds());
    for (const f of filters) {
      expect(vids.has(f.vendorId)).toBe(true);
      // Chromium refuses the protected keyboard/mouse collections; a picker
      // entry for one would be a device the app then cannot talk to.
      expect(f.usagePage).toBeGreaterThanOrEqual(0xff00);
    }
    const keys = filters.map((f) => `${f.vendorId}:${f.usagePage}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
