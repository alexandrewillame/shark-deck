import { beforeEach, describe, expect, it } from 'vitest';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';
import { frameLog } from '../../diagnostics';
import { CompxHeKeyboard } from './compx-he-keyboard';

/**
 * Live travel (magnetism page 254) had no read coverage. This page is what
 * the Actuation tab's Test view, its live "deepest key" preview and the
 * calibration overlay all consume, and it was reporting a slot that is not a
 * key: slot 126 reads a constant non-sentinel word at rest on an R85HE, so
 * the Test view showed "126" permanently pressed.
 *
 * The fixture is synthetic, not a capture: 128 uint16-LE slots split into
 * the page's 4 chunks of 64 data bytes, behind the reply's report id.
 */

const TRAVEL_PAGE = 254;
const MULT = 200; // R85HE fw >= 1280: mm * 200

/** Slots on the R85HE's ANSI_79_SG9047 layout, and two that are not keys. */
const SLOT = { A: 9, D: 21, UNPOPULATED: 10, TAIL: 126, LAST: 127 };

class TravelHe extends CompxHeKeyboard {
  protected readonly settleMs = 0;
  protected override async travelMultiplier(): Promise<number> {
    return MULT;
  }
}

function driver(slots: Record<number, number>): TravelHe {
  const units = new Array<number>(128).fill(0);
  for (const [slot, v] of Object.entries(slots)) units[Number(slot)] = v;
  let q = { page: -1, chunk: -1 };
  const io = {
    // `compx-fea` lays the GET args from byte 2: page, 1, chunk.
    write: async (f: Uint8Array) => void (q = { page: f[2] ?? -1, chunk: f[4] ?? -1 }),
    read: async (): Promise<Buffer | null> => {
      if (q.page !== TRAVEL_PAGE) return null;
      const data = Buffer.alloc(64);
      for (let i = 0; i < 32; i++) data.writeUInt16LE(units[q.chunk * 32 + i]!, i * 2);
      return Buffer.concat([Buffer.from([0x00]), data]);
    },
  };
  return new TravelHe({
    descriptor: ATTACK_SHARK_R85HE,
    channel: { transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io) } as never,
    onWarning: () => undefined,
  });
}

describe('live travel (page 254)', () => {
  beforeEach(() => frameLog.clear());

  it('reports layout keys only, not the non-key word in slot 126', async () => {
    const s = await driver({
      [SLOT.A]: 2 * MULT,
      [SLOT.TAIL]: 3 * MULT, // between the 2.5 mm default and the 4.2 mm gate
      [SLOT.LAST]: 0xffff,
    }).readTravel();
    expect(s?.complete).toBe(true);
    expect(s?.keys).toEqual([{ slot: SLOT.A, mm: 2 }]);
  });

  it('ignores an unpopulated matrix position', async () => {
    const s = await driver({ [SLOT.UNPOPULATED]: 2 * MULT, [SLOT.D]: 1 * MULT }).readTravel();
    expect(s?.keys).toEqual([{ slot: SLOT.D, mm: 1 }]);
  });

  it('does not let an off-layout slot trip the sanity gate', async () => {
    // 4.5 mm is past TRAVEL_MAX_MM. Counted as a key, it marked every sample
    // incomplete — a live monitor that never shows anything, with no hint why.
    const s = await driver({ [SLOT.A]: 2 * MULT, [SLOT.TAIL]: 4.5 * MULT }).readTravel();
    expect(s?.complete).toBe(true);
    expect(s?.keys).toEqual([{ slot: SLOT.A, mm: 2 }]);
  });

  it('still discards an implausible sample from a real key', async () => {
    const s = await driver({ [SLOT.A]: 4.5 * MULT }).readTravel();
    expect(s?.complete).toBe(false);
    expect(s?.keys).toEqual([]);
  });

  it('records what an ignored slot held, once per slot', async () => {
    const d = driver({ [SLOT.TAIL]: 0x0258 });
    await d.readTravel();
    await d.readTravel();
    const notes = frameLog.all().filter((e) => e.note?.includes('slot 126'));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('0x0258');
  });
});
