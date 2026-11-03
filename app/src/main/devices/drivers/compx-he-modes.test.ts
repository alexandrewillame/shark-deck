import { describe, expect, it } from 'vitest';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';
import { CompxHeKeyboard } from './compx-he-keyboard';

/**
 * Key modes on the read side, and the per-zone bindings mod-tap and DKS keys
 * carry. Synthetic pages, not the snapshot: the one capture this repo has
 * holds no snap-tap variant, no DKS key and no zone binding.
 */

const layout = ATTACK_SHARK_R85HE.spec.keyMatrix!.layout!;
const at = (slot: number) => layout.find((e) => e.slot === slot)!;
const SLOT = { A: 9, W: 14, S: 15, D: 21 };

/** Pages as `readMagnetismPage` returns them: one number per slot. */
class StubHe extends CompxHeKeyboard {
  pages = new Map<number, number[]>();
  protected readonly settleMs = 0;
  protected override async travelMultiplier(): Promise<number> {
    return 200;
  }
  protected override async readMagnetismPage(page: number): Promise<number[] | null> {
    return this.pages.get(page) ?? new Array(128).fill(0);
  }
}

const page = (values: Record<number, number>, fill = 0) => {
  const out = new Array(128).fill(fill);
  for (const [slot, v] of Object.entries(values)) out[Number(slot)] = v;
  return out;
};

describe('reading key modes', () => {
  const d = new StubHe({
    descriptor: ATTACK_SHARK_R85HE,
    channel: null as never,
    onWarning: () => undefined,
  });
  d.pages.set(0, page({}, 500)); // 2.5 mm everywhere
  d.pages.set(7, page({ [SLOT.A]: 0x09, [SLOT.D]: 0x8a, [SLOT.W]: 0x08, [SLOT.S]: 0x02 }));
  d.pages.set(9, page({ [SLOT.A]: SLOT.D, [SLOT.D]: SLOT.A }, 0xff));
  d.pages.set(4, page({}, 140)); // 0.7 mm, on every slot of the page

  const keyAt = async (slot: number) => {
    const e = at(slot);
    return (await d.readMagnetic()).find((k) => k.row === e.row && k.col === e.col)!;
  };

  it('reads 8, 9 and 10 as snap-tap — not as plain keys', async () => {
    // They used to decode as "normal", so a pair read back as two plain keys
    // and the next write unpaired it. The board ignores these values (see
    // `isSnapNum`), but a key holding one is still half of a pair.
    expect(await keyAt(SLOT.A)).toMatchObject({
      mode: 'snap',
      socdPartner: { row: at(SLOT.D).row, col: at(SLOT.D).col },
    });
    expect(await keyAt(SLOT.D)).toMatchObject({
      mode: 'snap',
      rapidTrigger: true,
      socdPartner: { row: at(SLOT.A).row, col: at(SLOT.A).col },
    });
    expect(await keyAt(SLOT.W)).toMatchObject({ mode: 'snap', socdPartner: null });
  });

  it('gives a DKS point to DKS keys only', async () => {
    expect((await keyAt(SLOT.S)).dksPointMm).toBeCloseTo(0.7, 6);
    // Page 4 is read for the whole board once any key is in DKS; the rest of
    // its slots mean nothing, and must not make identical keys differ.
    expect((await keyAt(SLOT.A)).dksPointMm).toBeUndefined();
    expect((await keyAt(4)).dksPointMm).toBeUndefined(); // Shift, a plain key
  });

  it('leaves the partner off keys that are not snap-tap', async () => {
    expect((await keyAt(SLOT.S)).socdPartner).toBeNull();
  });
});

describe('zone bindings (multi-frame SET_KEYMATRIX)', () => {
  const setup = () => {
    const sent: number[][] = [];
    const kept = new Map<string, unknown>();
    const d = new StubHe({
      descriptor: ATTACK_SHARK_R85HE,
      channel: { write: async (f: Uint8Array) => void sent.push([...f]) } as never,
      onWarning: () => undefined,
      state: { get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, v) },
    });
    return { d, sent };
  };

  it('sends one frame per zone, the remap frame with its zone byte, committing once', async () => {
    const { d, sent } = setup();
    const r = await d.setKeyZoneBindings(SLOT.A, ['04', 'e0', '', '00e30007']);
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(4);
    // [report, cmd, layer, slot, pad, pad, commit, zone, ck, quad...]
    expect(sent.map((f) => f.slice(1, 8))).toEqual([
      [0x0a, 0, SLOT.A, 0, 0, 0, 0],
      [0x0a, 0, SLOT.A, 0, 0, 0, 1],
      [0x0a, 0, SLOT.A, 0, 0, 0, 2],
      [0x0a, 0, SLOT.A, 0, 0, 1, 3],
    ]);
    expect(sent.map((f) => f.slice(9, 13))).toEqual([
      [0, 0, 0x04, 0],
      [0, 0, 0xe0, 0],
      [0, 0, 0, 0], // '' — nothing in this zone
      [0, 0xe3, 0, 0x07],
    ]);
  });

  it('keeps what it wrote, since the board will not say', async () => {
    const { d } = setup();
    expect(await d.readKeyZoneBindings()).toEqual({});
    await d.setKeyZoneBindings(SLOT.A, ['e1', '04']);
    await d.setKeyZoneBindings(SLOT.D, [null, '05', '06', '07']);
    expect(await d.readKeyZoneBindings()).toEqual({
      [SLOT.A]: ['e1', '04'],
      [SLOT.D]: [null, '05', '06', '07'],
    });
  });

  it('leaves a null zone alone, committing on the last frame it does send', async () => {
    // Zone 0 is the key's own binding — the Remap tab's — and DKS leaves it
    // as it is: it is the key's first action.
    const { d, sent } = setup();
    expect((await d.setKeyZoneBindings(SLOT.A, [null, 'e1'])).ok).toBe(true);
    expect(sent.map((f) => [f[6], f[7], f[11]])).toEqual([[1, 1, 0xe1]]);
    expect(await d.readKeyZoneBindings()).toEqual({ [SLOT.A]: [null, 'e1'] });
  });

  it("refuses a mod-tap hold with nothing for the key's own binding to go back to", async () => {
    // Zone 0 written is a hold over the key's own binding. Without the tap in
    // zone 1, leaving mod-tap would have nothing to put back.
    const { d, sent } = setup();
    expect((await d.setKeyZoneBindings(SLOT.A, ['e0'])).ok).toBe(false);
    expect((await d.setKeyZoneBindings(SLOT.A, ['e0', ''])).ok).toBe(false);
    expect((await d.setKeyZoneBindings(SLOT.A, ['e0', null])).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('refuses a binding it cannot encode, or the wrong number of zones, sending nothing', async () => {
    const { d, sent } = setup();
    expect((await d.setKeyZoneBindings(SLOT.A, [null, null])).ok).toBe(false);
    expect((await d.setKeyZoneBindings(SLOT.A, ['04', 'zz'])).ok).toBe(false);
    expect((await d.setKeyZoneBindings(SLOT.A, [])).ok).toBe(false);
    expect((await d.setKeyZoneBindings(SLOT.A, ['04', '05', '06', '07', '08'])).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });
});

/**
 * A mod-tap key's HOLD sits in zone 0 and its own binding, the TAP, in zone 1
 * — the board fires zone 0 on a hold (a hardware check, 2026-10-09). So zone 0
 * is written over while a key is mod-tap, and has to come back.
 */
describe('mod-tap keys keep their own binding', () => {
  const MT_KEY = at(SLOT.A);
  const plainA = { row: MT_KEY.row, col: MT_KEY.col, actuationMm: 2, rapidTrigger: false };

  /** Every zone frame as `zone <z> slot <s> = <usage>`, and every page write. */
  class LogHe extends StubHe {
    log: string[] = [];
    matrix: number[] = new Array(512).fill(0);
    protected override async writeMagKey(page: number, slot: number) {
      this.log.push(`page ${page} slot ${slot}`);
      return { ok: true, verified: 'unverified' as const };
    }
    protected override async readMatrixChunks(): Promise<number[] | null> {
      return this.matrix;
    }
  }
  const setup = (record: Record<number, Array<string | null>> = {}) => {
    const kept = new Map<string, unknown>([['zoneBindings', record]]);
    const frame = (f: Uint8Array) => `zone ${f[7]} slot ${f[3]} = ${f[11]?.toString(16)}`;
    const d: LogHe = new LogHe({
      descriptor: ATTACK_SHARK_R85HE,
      channel: {
        write: async (f: Uint8Array) => void d.log.push(frame(f)),
        request: async () => null,
        transaction: async (fn: (io: unknown) => unknown) =>
          fn({
            write: async (f: Uint8Array) => void d.log.push(frame(f)),
            request: async () => null,
          }),
      } as never,
      onWarning: () => undefined,
      state: { get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, v) },
    });
    return d;
  };

  it('puts the key back in zone 0 when it leaves mod-tap, before any page', async () => {
    const d = setup({ [SLOT.A]: ['e0', '04'] });
    expect((await d.setMagneticKey({ ...plainA, mode: 'normal' })).ok).toBe(true);
    expect(d.log[0]).toBe(`zone 0 slot ${SLOT.A} = 4`);
    expect(d.log.slice(1).every((l) => l.startsWith('page'))).toBe(true);
    expect(await d.readKeyZoneBindings()).toEqual({});
  });

  it('does it for every key of a batch, and only for keys leaving mod-tap', async () => {
    const d = setup({ [SLOT.A]: ['e0', '04'], [SLOT.D]: ['e1', '07'] });
    const atD = at(SLOT.D);
    await d.setMagneticKeys([
      { ...plainA, mode: 'tgl_hold' },
      {
        row: atD.row,
        col: atD.col,
        actuationMm: 2,
        rapidTrigger: false,
        mode: 'mt',
        mtHoldMs: 200,
      },
    ]);
    expect(d.log.filter((l) => l.startsWith('zone'))).toEqual([`zone 0 slot ${SLOT.A} = 4`]);
    expect(await d.readKeyZoneBindings()).toEqual({ [SLOT.D]: ['e1', '07'] });
  });

  it('leaves the bindings alone for a write to another profile', async () => {
    // The key matrix is not the slot's: a copy into another profile must not
    // undo a mod-tap key on the one in use.
    const d = setup({ [SLOT.A]: ['e0', '04'] });
    await d.setMagneticKeys([{ ...plainA, mode: 'normal' }], undefined, {
      keepZoneBindings: true,
    });
    expect(d.log.some((l) => l.startsWith('zone'))).toBe(false);
    expect(await d.readKeyZoneBindings()).toEqual({ [SLOT.A]: ['e0', '04'] });
  });

  it('gives the key its own binding back when it goes from mod-tap to DKS', async () => {
    // DKS keeps the key's own binding as its first action, in zone 0.
    const d = setup({ [SLOT.A]: ['e0', '04'] });
    await d.setKeyZoneBindings(SLOT.A, [null, '05', '06', '07']);
    expect(d.log).toEqual([
      `zone 0 slot ${SLOT.A} = 4`,
      `zone 1 slot ${SLOT.A} = 5`,
      `zone 2 slot ${SLOT.A} = 6`,
      `zone 3 slot ${SLOT.A} = 7`,
    ]);
    expect(await d.readKeyZoneBindings()).toEqual({ [SLOT.A]: [null, '05', '06', '07'] });
  });

  it('remaps a mod-tap key by changing what it taps', async () => {
    const d = setup({ [SLOT.A]: ['e0', '04'] });
    expect((await d.setKeyRemap('base', SLOT.A, '05')).ok).toBe(true);
    expect(d.log).toEqual([`zone 1 slot ${SLOT.A} = 5`]);
    expect(await d.readKeyZoneBindings()).toEqual({ [SLOT.A]: ['e0', '05'] });
    // Any other key is remapped as ever, in zone 0.
    await d.setKeyRemap('base', SLOT.D, '06');
    expect(d.log.at(-1)).toBe(`zone 0 slot ${SLOT.D} = 6`);
  });

  it('shows a mod-tap key on the base layer as what it types, not as its hold', async () => {
    const d = setup({ [SLOT.A]: ['e0', '04'] });
    d.matrix[SLOT.A * 4 + 2] = 0xe0; // zone 0 holds the hold, as written
    const base = (await d.readKeyBindings('base'))!;
    expect(base[SLOT.A]!.code).toBe('04');
    // A record the board has moved on from (zone 0 is something else now) is
    // not believed.
    d.matrix[SLOT.A * 4 + 2] = 0x16;
    expect((await d.readKeyBindings('base'))![SLOT.A]!.code).toBe('16');
  });

  it('forgets the record on a factory reset', async () => {
    const d = setup({ [SLOT.A]: ['e0', '04'] });
    expect((await d.restoreDefaults()).ok).toBe(true);
    expect(await d.readKeyZoneBindings()).toEqual({});
  });

  it('does not throw for want of somewhere to keep a record', async () => {
    // The diagnostic scripts build the driver with a bare `state: {}`.
    const d = new LogHe({
      descriptor: ATTACK_SHARK_R85HE,
      channel: null as never,
      onWarning: () => undefined,
      state: {} as never,
    });
    expect(await d.readKeyZoneBindings()).toEqual({});
    expect(await d.readKeyBindings('base')).not.toBeNull();
  });
});

describe('backup and restore carry Mod-tap and DKS whole', () => {
  const MT = SLOT.A;
  const DKS = SLOT.S;
  const PLAIN = SLOT.D;

  /** Records the order things reach the board in: zone frames and page writes. */
  class RecordingHe extends StubHe {
    log: string[] = [];
    protected override backupPaceMs = 0;
    override async readKeyBindings() {
      return null;
    }
    override async readPerKeyLighting() {
      return null;
    }
    override async readMacros() {
      return [];
    }
    protected override async writeMagKey(
      page: number,
      slot: number,
      value: number | number[],
      commit: boolean,
    ) {
      this.log.push(`page ${page} slot ${slot} = ${String(value)}${commit ? ' commit' : ''}`);
      return { ok: true, verified: 'unverified' as const };
    }
  }
  const setup = () => {
    const kept = new Map<string, unknown>();
    const d: RecordingHe = new RecordingHe({
      descriptor: ATTACK_SHARK_R85HE,
      channel: {
        write: async (f: Uint8Array) => void d.log.push(`zone ${f[7]} slot ${f[3]}`),
        request: async () => null,
      } as never,
      onWarning: () => undefined,
      state: { get: async (k) => kept.get(k), set: async (k, v) => void kept.set(k, v) },
    });
    return d;
  };

  it('backs up the bindings record, and never the unreadable page 8', async () => {
    const d = setup();
    await d.setKeyZoneBindings(MT, ['e0', '04']);
    const blocks = await d.backup();
    // The board has no read-back for them: the record is the only copy.
    expect(JSON.parse(blocks.zone_bindings!)).toEqual({ [MT]: ['e0', '04'] });
    // Page 8 reads back our own checksum. The flags are kept from page 10.
    expect(blocks).not.toHaveProperty('magnetism_page_8');
    expect(blocks).toHaveProperty('magnetism_page_10');
  });

  it('restores them in the vendor order: bindings, then the pages, then the DKS flags', async () => {
    const d = setup();
    const r = await d.restoreFromBackup({
      magnetism_page_7: JSON.stringify(page({ [MT]: 3, [DKS]: 2, [PLAIN]: 0x80 })),
      magnetism_page_4: JSON.stringify(page({ [DKS]: 140 })),
      // A backup taken before page 8 was skipped: our own echoed checksum.
      magnetism_page_8: JSON.stringify(page({ [PLAIN]: 17, [DKS]: 16 })),
      magnetism_page_10: JSON.stringify(page({ [DKS]: 0x40100401, [PLAIN]: 0xffff })),
      zone_bindings: JSON.stringify({
        [MT]: ['e0', '04'],
        [DKS]: [null, '05', '06', '07'],
        // Recorded once, but the backup has this key plain: nothing uses it.
        [PLAIN]: [null, 'e1'],
      }),
    });
    expect(r.ok).toBe(true);

    const zones = d.log.filter((l) => l.startsWith('zone'));
    expect(zones).toEqual([
      `zone 0 slot ${MT}`,
      `zone 1 slot ${MT}`,
      `zone 1 slot ${DKS}`,
      `zone 2 slot ${DKS}`,
      `zone 3 slot ${DKS}`,
    ]);
    const firstPage = d.log.findIndex((l) => l.startsWith('page'));
    expect(firstPage).toBe(zones.length);

    // Page 10 is the read side, so nothing is written there; page 8 gets only
    // the DKS key's flags, from page 10, and last.
    expect(d.log.some((l) => l.startsWith('page 10 '))).toBe(false);
    expect(d.log.filter((l) => l.startsWith('page 8 '))).toEqual([
      `page 8 slot ${DKS} = ${0x40100401} commit`,
    ]);
    expect(d.log.at(-1)).toBe(`page 8 slot ${DKS} = ${0x40100401} commit`);
    // ...and the record now says what the board was given.
    expect(await d.readKeyZoneBindings()).toEqual({
      [MT]: ['e0', '04'],
      [DKS]: [null, '05', '06', '07'],
    });
  });

  it('turns a mod-tap entry recorded the old way round, from the backed-up base layer', async () => {
    const d = setup();
    await d.restoreFromBackup({
      magnetism_page_7: JSON.stringify(page({ [MT]: 3 })),
      keymatrix_base: JSON.stringify({ [MT]: { kind: 'key', code: '04', raw: [0, 0, 4, 0] } }),
      zone_bindings: JSON.stringify({ [MT]: [null, 'e0'] }),
    });
    expect(await d.readKeyZoneBindings()).toEqual({ [MT]: ['e0', '04'] });
  });

  it('takes a key that is mod-tap now but plain in the backup out of mod-tap', async () => {
    const d = setup();
    await d.setKeyZoneBindings(MT, ['e0', '04']);
    d.log = [];
    await d.restoreFromBackup({
      // MT is 0 here: plain. The modes loop skips zeros, but not this one.
      magnetism_page_7: JSON.stringify(page({ [DKS]: 2 })),
    });
    // Its own binding goes back in zone 0 first, and its mode is written.
    expect(d.log[0]).toBe(`zone 0 slot ${MT}`);
    expect(d.log).toContain(`page 7 slot ${MT} = 0`);
    expect(d.log.some((l) => l.startsWith(`page 7 slot ${PLAIN}`))).toBe(false);
    expect(await d.readKeyZoneBindings()).toEqual({});
  });
});
