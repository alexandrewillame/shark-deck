import { describe, expect, it, vi } from 'vitest';
import type { ActuationLayout, MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { WriteResult } from '@shared/types/live';
import type { Driver } from '../devices/drivers/base';
import { writeActuationLayout } from './apply';

/**
 * Applying a saved layout brings its Mod-tap and DKS keys back with their
 * bindings: the hold key, the DKS actions. They are key-matrix bindings, not
 * magnetism pages, so `setMagneticKeys` alone put a key back into Mod-tap with
 * whatever hold the board happened to have.
 */

const BOARD = [
  { label: 'A', row: 0, col: 0, slot: 9 },
  { label: 'S', row: 0, col: 1, slot: 15 },
  { label: 'D', row: 0, col: 2 }, // no slot: the layout index stands in
];

const key = (col: number, mode?: MagneticKeySettings['mode']): MagneticKeySettings => ({
  row: 0,
  col,
  actuationMm: 2,
  rapidTrigger: false,
  ...(mode ? { mode } : {}),
});

const saved = (over: Partial<ActuationLayout>): ActuationLayout => ({
  id: 'l1',
  name: 'Layout 1',
  createdAt: 0,
  keys: [],
  groups: [],
  ...over,
});

/** The board's own bindings: A on slot 9, D at layout index 2. */
const OWN: Record<number, { raw: number[] }> = {
  9: { raw: [0, 0, 4, 0] },
  2: { raw: [0, 0, 7, 0] },
};

function board(refuseSlot?: number) {
  const log: string[] = [];
  const driver = {
    descriptor: { spec: { keyMatrix: { layout: BOARD } } },
    readKeyBindings: vi.fn(async () => {
      log.push('read base');
      return OWN;
    }),
    setKeyZoneBindings: vi.fn(async (slot: number, zones: Array<string | null>) => {
      log.push(`zones ${slot}: ${zones.join(',')}`);
      return slot === refuseSlot
        ? ({ ok: false, verified: 'unverified', error: 'refused', frames: ['z!'] } as WriteResult)
        : ({ ok: true, verified: 'unverified', frames: [`z${slot}`] } as WriteResult);
    }),
    setMagneticKeys: vi.fn(async (keys: MagneticKeySettings[]) => {
      log.push(`keys x${keys.length}`);
      return { ok: true, verified: 'unverified', frames: ['k'] } as WriteResult;
    }),
  };
  return { driver: driver as unknown as Driver, log };
}

describe('applying a saved actuation layout', () => {
  it('binds its Mod-tap and DKS keys first, then writes the keys', async () => {
    const { driver, log } = board();
    const r = await writeActuationLayout(
      driver,
      saved({
        keys: [key(0, 'mt'), key(1, 'dks'), key(2, 'mt')],
        zoneBindings: [
          // Mod-tap: the hold in zone 0, the key's own binding (the tap) in 1.
          { row: 0, col: 0, zones: ['e0', '04'] },
          { row: 0, col: 1, zones: [null, '05', '06', '07'] },
          { row: 0, col: 2, zones: ['e1', '07'] },
        ],
      }),
    );
    expect(log).toEqual(['zones 9: e0,04', 'zones 15: ,05,06,07', 'zones 2: e1,07', 'keys x3']);
    expect(r).toMatchObject({ ok: true, frames: ['z9', 'z15', 'z2', 'k'] });
  });

  it('binds only keys the layout puts in those modes, on positions this board has', async () => {
    const { driver, log } = board();
    await writeActuationLayout(
      driver,
      saved({
        keys: [key(0, 'normal'), key(1, 'dks'), { ...key(5, 'mt'), row: 4 }],
        zoneBindings: [
          { row: 0, col: 0, zones: [null, 'e0'] }, // the key is plain now
          { row: 0, col: 1, zones: [null, null, null, null] }, // nothing to send
          { row: 4, col: 5, zones: [null, 'e2'] }, // another model's key
        ],
      }),
    );
    expect(log).toEqual(['keys x3']);
  });

  it('stops before any key changes mode when the board refuses a binding', async () => {
    const { driver, log } = board(15);
    const r = await writeActuationLayout(
      driver,
      saved({
        keys: [key(0, 'mt'), key(1, 'dks')],
        zoneBindings: [
          { row: 0, col: 0, zones: ['e0', '04'] },
          { row: 0, col: 1, zones: [null, '05', '06', '07'] },
        ],
      }),
    );
    expect(log).toEqual(['zones 9: e0,04', 'zones 15: ,05,06,07']);
    expect(r).toMatchObject({ ok: false, error: 'refused', frames: ['z9', 'z!'] });
  });

  it('turns a Mod-tap entry saved the old way round the right way, from the board', async () => {
    // `[null, hold]` was the order before a hardware check showed the board
    // fires zone 0 on a HOLD. Sent as it stands, A would tap Ctrl and hold `a`.
    const { driver, log } = board();
    await writeActuationLayout(
      driver,
      saved({
        keys: [key(0, 'mt'), key(2, 'mt')],
        zoneBindings: [
          { row: 0, col: 0, zones: [null, 'e0'] },
          { row: 0, col: 2, zones: [null, 'e1'] },
        ],
      }),
    );
    // One read of the board's bindings, for both keys.
    expect(log).toEqual(['read base', 'zones 9: e0,04', 'zones 2: e1,07', 'keys x2']);
  });

  it('leaves an old-way-round key unbound when its own binding cannot be read', async () => {
    const { driver, log } = board();
    (driver.readKeyBindings as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await writeActuationLayout(
      driver,
      saved({ keys: [key(0, 'mt')], zoneBindings: [{ row: 0, col: 0, zones: [null, 'e0'] }] }),
    );
    expect(log).toEqual(['keys x1']);
  });

  it('writes a layout saved before bindings were kept as just its keys', async () => {
    const { driver, log } = board();
    const r = await writeActuationLayout(driver, saved({ keys: [key(0, 'mt')] }));
    expect(log).toEqual(['keys x1']);
    expect(r.frames).toEqual(['k']);
  });
});
