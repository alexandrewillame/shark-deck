import { describe, expect, it } from 'vitest';
import { ATTACK_SHARK_R85HE } from './catalog/r85he';
import { ATTACK_SHARK_V8, ATTACK_SHARK_V8_WIRED } from './catalog/v8';
import { KEYBOARDS } from './catalog/keyboards';
import { hidRequestFilters, knownVendorIds, resolveDescriptor } from './registry';
import { resolveIdentity } from './identity';
import { deviceUi } from './deviceUi';

/**
 * VID/PID names a protocol family, never a device. ~99 boards of several
 * brands share 3151:5029, and 3554:F517 is both the V8's dongle and another
 * brand's mouse. Since every per-key write is addressed by slot, resolving to
 * the wrong model writes to the wrong keys — and resolving another brand's
 * device to an Attack Shark one writes our settings into it. So a device is
 * attached `pending` and bound only from what its firmware says it is.
 */

describe('resolveDescriptor (VID/PID -> family, pending)', () => {
  it('attaches every ROYUAN endpoint pending, whatever its PID', () => {
    for (const [vid, pid] of [
      [0x3151, 0x5029],
      [0x3151, 0x5030],
      [0x39ab, 0x9016],
    ] as const) {
      const d = resolveDescriptor(vid, pid)!;
      expect(d.identity).toBe('pending');
      expect(d.capabilities).toEqual([]);
      expect(d.driver).toBe('royuan-identify');
      expect([d.vid, d.pid]).toEqual([vid, pid]);
    }
  });

  it('attaches every Hub endpoint pending, the cable marked as such', () => {
    const dongle = resolveDescriptor(0x3554, 0xf517)!;
    const cable = resolveDescriptor(0x3554, 0xf515)!;
    for (const d of [dongle, cable]) {
      expect(d.identity).toBe('pending');
      expect(d.driver).toBe('hub-identify');
      expect(d.capabilities).toEqual([]);
    }
    // the cable still wins over the receiver when both enumerate
    expect(dongle.wired).toBeUndefined();
    expect(cable.wired).toBe(true);
    // one family slug across endpoints, so dongle + cable stay one card
    expect(dongle.model).toBe(cable.model);
  });

  it('returns null for an unrelated device', () => {
    expect(resolveDescriptor(0x1234, 0x5678)).toBeNull();
  });
});

describe('resolveIdentity (what the firmware says)', () => {
  it('binds the R85HE to its hand-verified descriptor', () => {
    const d = resolveIdentity({ vid: 0x3151, pid: 0x5029 }, { family: 'royuan', modelId: 3123 });
    expect(d).toBe(ATTACK_SHARK_R85HE);
  });

  it('binds a board that shares the R85HE PID to its own model', () => {
    // An R86 PRO HE on 3151:5029 used to wear the R85HE's 79-key layout.
    const d = resolveIdentity({ vid: 0x3151, pid: 0x5029 }, { family: 'royuan', modelId: 2982 });
    expect(d.displayName).toBe('Attack Shark R86 PRO HE');
    expect(d.modelId).toBe(2982);
    expect(d.identity).toBe('exact');
  });

  it('binds to the endpoint the device actually came in on', () => {
    // 2370 is registered on 502F; the same board over another endpoint keeps
    // that endpoint's ids.
    const d = resolveIdentity({ vid: 0x3151, pid: 0x4011 }, { family: 'royuan', modelId: 2370 });
    expect([d.vid, d.pid]).toEqual([0x3151, 0x4011]);
  });

  it('gives another brand a read-only card, never a descriptor that writes', () => {
    // 2498 is a rongyuan board (qmk.top's GK6940GW)
    const d = resolveIdentity({ vid: 0x3151, pid: 0x502f }, { family: 'royuan', modelId: 2498 });
    expect(d.identity).toBe('foreign');
    expect(d.capabilities).toEqual([]);
    expect(d.driver).toBe('no-io');
  });

  it('gives an id no table knows a read-only card', () => {
    const d = resolveIdentity({ vid: 0x3151, pid: 0x5029 }, { family: 'royuan', modelId: 65000 });
    expect(d.identity).toBe('unknown');
    expect(d.identityNote).toContain('65000');
    expect(d.driver).toBe('no-io');
  });

  it('identifies the V8 from the reply our capture recorded (cid 124, mid 5)', () => {
    expect(
      resolveIdentity(
        { vid: 0x3554, pid: 0xf517 },
        { family: 'compx-hub', cid: 124, mid: 5, link: 5 },
      ),
    ).toBe(ATTACK_SHARK_V8);
    // the same mouse on its cable (link 3: wired 8K)
    const wired = resolveIdentity(
      { vid: 0x3554, pid: 0xf515 },
      { family: 'compx-hub', cid: 124, mid: 5, link: 3 },
    );
    expect(wired).toBe(ATTACK_SHARK_V8_WIRED);
    for (const cap of ['receiverLed', 'pairing', 'longDistanceMode'] as const) {
      expect(wired.capabilities, cap).not.toContain(cap);
    }
  });

  it('rejects another brand on the V8 dongle PID', () => {
    const d = resolveIdentity(
      { vid: 0x3554, pid: 0xf517 },
      { family: 'compx-hub', cid: 7, mid: 2, link: 5 },
    );
    expect(d.identity).toBe('foreign');
    expect(d.capabilities).toEqual([]);
  });

  it('offers no poll rate the link cannot carry', () => {
    // link 0: a 1K receiver
    const slow = resolveIdentity(
      { vid: 0x3554, pid: 0xf517 },
      { family: 'compx-hub', cid: 124, mid: 11, link: 0 },
    );
    expect(Math.max(...slow.spec.pollRates!)).toBe(1000);
    // the 8K link leaves the full list (and the V8 its own descriptor)
    const fast = resolveIdentity(
      { vid: 0x3554, pid: 0xf517 },
      { family: 'compx-hub', cid: 124, mid: 11, link: 5 },
    );
    expect(Math.max(...fast.spec.pollRates!)).toBe(8000);
  });

  it('gives a PAW3955 mouse its own DPI records and 15 macro slots', () => {
    const d = resolveIdentity(
      { vid: 0x3554, pid: 0xf517 },
      { family: 'compx-hub', cid: 124, mid: 20, link: 5 },
    );
    expect(d.displayName).toBe('Attack Shark F1 AIR');
    expect(d.spec.dpi?.codec).toBe('paw3955');
    expect(deviceUi(d).macroLimits?.slots).toBe(15);
    expect(deviceUi(ATTACK_SHARK_V8).macroLimits?.slots).toBe(16);
    // no coarser band on either: every UI step is a record the sensor stores
    expect(deviceUi(ATTACK_SHARK_V8).dpiRange?.coarseAbove).toBeUndefined();
    expect(deviceUi(d).dpiRange?.coarseAbove).toBeUndefined();
  });

  it('names an Attack Shark mouse of an unnamed model by its sensor class', () => {
    const d = resolveIdentity(
      { vid: 0x3554, pid: 0xfb44 },
      { family: 'compx-hub', cid: 124, mid: 13, link: 5 },
    );
    expect(d.identity).toBe('class');
    expect(d.spec.dpi?.codec).toBe('paw3955');
    expect(d.spec.dpi?.max).toBe(52000);
    // extras no store page confirms for the class stay off
    for (const cap of ['receiverLed', 'highFpsScan', 'longDistanceMode', 'angleMode'] as const) {
      expect(d.capabilities, cap).not.toContain(cap);
    }
  });
});

describe('the keyboard catalogue', () => {
  it('carries the R85HE under the model id its firmware reports', () => {
    // 0x0c33, read off a real R85HE (fw v5.11)
    expect(ATTACK_SHARK_R85HE.modelId).toBe(0x0c33);
    expect(KEYBOARDS.find((d) => d.modelId === 3123)).toBe(ATTACK_SHARK_R85HE);
  });
});

describe('the Beken mice', () => {
  it('get a named card where the PID is their own, and nothing is ever driven', () => {
    const x11 = resolveDescriptor(0x1d57, 0xfa55)!;
    expect(x11.displayName).toBe('Attack Shark X11');
    expect(x11.identity).toBe('unsupported');
    expect(x11.driver).toBe('no-io');
    expect(x11.capabilities).toEqual([]);
  });

  it('leave the receiver several brands share alone', () => {
    expect(resolveDescriptor(0x1d57, 0xfa60)).toBeNull();
  });
});

describe('hidRequestFilters (the browser edition device picker)', () => {
  const filters = hidRequestFilters();
  const covers = (vid: number, page: number) =>
    filters.some((f) => f.vendorId === vid && f.usagePage === page);

  it('offers every family by vendor id and config usage page', () => {
    for (const vid of [0x3151, 0x39ab]) expect(covers(vid, 0xffff)).toBe(true);
    expect(covers(0x3554, 0xff02)).toBe(true);
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
