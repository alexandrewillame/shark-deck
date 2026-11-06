import { describe, expect, it } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/device';
import type { KeyBinding } from '@shared/types/keys';
import type { WriteResult } from '@shared/types/live';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';
import { CompxHeKeyboard } from './compx-he-keyboard';
import { decodeQuad } from './compx-keyboard';

/**
 * A magnetic board whose layout names no slots — most of the line, until its
 * slot map is known — still has whole-board settings. The keys they reach are
 * the slots its own base keymap binds, never the layout's array index (which
 * is how a write used to land on the wrong key) and never nothing at all
 * (which is what `setMagneticGlobal` wrote to such a board before).
 *
 * The board here is an R85HE whose layout has had its slots taken away, so
 * the answer is known: the keys found must be exactly the R85HE's own.
 */
const R85HE_LAYOUT = ATTACK_SHARK_R85HE.spec.keyMatrix!.layout!;
const KEY_SLOTS = R85HE_LAYOUT.map((k) => k.slot!).sort((a, b) => a - b);

const NO_SLOTS: DeviceDescriptor = {
  ...ATTACK_SHARK_R85HE,
  spec: {
    ...ATTACK_SHARK_R85HE.spec,
    keyMatrix: {
      ...ATTACK_SHARK_R85HE.spec.keyMatrix!,
      layoutStatus: 'none',
      layout: R85HE_LAYOUT.map(({ slot: _slot, ...k }) => k),
    },
  },
};

/**
 * The board's base keymap as a real R85HE reports it: each key's own code at
 * its slot, Fn a firmware key — and its knob, bound too, at slots 90-92
 * (Volume up / down / mute) though it is no switch.
 */
function keymap(): Record<number, KeyBinding> {
  const out: Record<number, KeyBinding> = {};
  for (let slot = 0; slot < 128; slot++) out[slot] = decodeQuad(slot, [0, 0, 0, 0]);
  for (const k of R85HE_LAYOUT) {
    out[k.slot!] = decodeQuad(
      k.slot!,
      typeof k.code === 'number' ? [0, 0, k.code, 0] : [10, 1, 0, 0],
    );
  }
  out[90] = decodeQuad(90, [3, 0, 0xe9, 0]);
  out[91] = decodeQuad(91, [3, 0, 0xea, 0]);
  out[92] = decodeQuad(92, [3, 0, 0xe2, 0]);
  return out;
}

/**
 * Magnetism pages shaped like the R85HE's (fw 5.11): every switch has its
 * travel and its factory bottom dead zone, the knob's and the empty slots are
 * zero on every page.
 */
const onKeys = (v: number) =>
  Array.from({ length: 128 }, (_, s) => (KEY_SLOTS.includes(s) ? v : 0));
const DEADZONE_BOTTOM = onKeys(60);

class Board extends CompxHeKeyboard {
  protected readonly settleMs = 0;
  readonly writes: { page: number; slot: number }[] = [];
  keymapReads = 0;
  constructor(
    descriptor: DeviceDescriptor,
    private readonly travel: number[] = onKeys(500),
  ) {
    super({ descriptor, channel: null as never, onWarning: () => undefined });
  }
  protected override async travelMultiplier(): Promise<number> {
    return 200;
  }
  protected override async readMagnetismPage(page: number): Promise<number[] | null> {
    if (page === 0) return this.travel;
    if (page === 6) return DEADZONE_BOTTOM;
    return new Array(128).fill(0);
  }
  override async readKeyBindings(layer: 'base' | 'fn'): Promise<Record<number, KeyBinding> | null> {
    if (layer !== 'base') return null;
    this.keymapReads++;
    return keymap();
  }
  protected override async writeMagKey(page: number, slot: number): Promise<WriteResult> {
    this.writes.push({ page, slot });
    return { ok: true, verified: 'unverified' };
  }
}

describe('a magnetic board without a slot map', () => {
  it('reads exactly its switches: bound and configured, the knob left out', async () => {
    const b = new Board(NO_SLOTS);
    const keys = await b.readMagnetic();
    expect(keys.map((k) => k.col * 6 + k.row).sort((x, y) => x - y)).toEqual(KEY_SLOTS);
  });

  it('writes a whole-board actuation to every one of those keys, and only those', async () => {
    const b = new Board(NO_SLOTS);
    const r = await b.setMagneticGlobal(2.0);
    expect(r.ok).toBe(true);
    const slots = b.writes.filter((w) => w.page === 0).map((w) => w.slot);
    expect([...slots].sort((x, y) => x - y)).toEqual(KEY_SLOTS);
  });

  it('round-trips a whole-board edit through the keys it read', async () => {
    const b = new Board(NO_SLOTS);
    const before = await b.readMagnetic();
    const next = before.map((k) => ({ ...k, actuationMm: 1.2 }));
    expect((await b.setMagneticKeys(next, before)).ok).toBe(true);
    const slots = new Set(b.writes.map((w) => w.slot));
    expect([...slots].sort((x, y) => x - y)).toEqual(KEY_SLOTS);
  });

  it('keeps a switch whose travel page is unset when its other pages are not', async () => {
    const travel = onKeys(500);
    travel[KEY_SLOTS[0]!] = 0; // "not set": the firmware's table default
    const keys = await new Board(NO_SLOTS, travel).readMagnetic();
    expect(keys).toHaveLength(KEY_SLOTS.length);
  });

  it('drops a slot the travel page marks as having no switch', async () => {
    const travel = onKeys(500);
    travel[KEY_SLOTS[0]!] = 0xffff;
    const b = new Board(NO_SLOTS, travel);
    const keys = await b.readMagnetic();
    expect(keys).toHaveLength(KEY_SLOTS.length - 1);
  });

  it('reads the keymap once, not on every write', async () => {
    const b = new Board(NO_SLOTS);
    await b.readMagnetic();
    await b.setMagneticGlobal(1.5);
    await b.readMagnetic();
    expect(b.keymapReads).toBe(1);
  });
});

describe('a board whose layout names its slots', () => {
  it('takes its keys from the layout and never reads the keymap for them', async () => {
    const b = new Board(ATTACK_SHARK_R85HE);
    const keys = await b.readMagnetic();
    expect(keys).toHaveLength(R85HE_LAYOUT.length);
    expect(b.keymapReads).toBe(0);
    // and keeps the layout's own row/col, which the Actuation tab draws by
    for (const k of R85HE_LAYOUT) {
      expect(keys.some((m) => m.row === k.row && m.col === k.col)).toBe(true);
    }
  });
});
