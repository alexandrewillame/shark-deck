import { beforeEach, describe, expect, it } from 'vitest';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { WriteResult } from '@shared/types/live';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';
import { CompxHeKeyboard } from './compx-he-keyboard';

/**
 * The magnetic write path had no unit coverage at all: 759 lines validated
 * only by scripts run against a real R85HE, which is the most expensive
 * verification loop in the repo and cannot exercise the branches that matter
 * most (a partner key that is not in the matrix, a page that refuses a write).
 *
 * These record at `writeMagKey`, the single choke point every magnetism write
 * funnels through. That is deliberately not the wire: what is worth pinning
 * here is WHICH pages a setting produces, with what values, in what order, and
 * where the commit flag lands. The frame layout itself is capture-verified and
 * covered by the checksum vectors.
 *
 * Page numbers are asserted as literals on purpose. They are the protocol; if
 * one changes, that should be a deliberate edit here too.
 */

const PAGE = {
  TRAVEL: 0,
  RELEASE: 1,
  RT_PRESS: 2,
  RT_RELEASE: 3,
  DKS_POINTS: 4,
  MT: 5,
  DEADZONE_BOTTOM: 6,
  MODES: 7,
  SNAP: 9,
  DKS_FLAGS: 8,
  DEADZONE_TOP: 251,
} as const;

const SOCD_NO_PARTNER = 0xff;

interface Rec {
  page: number;
  slot: number;
  value: number | number[];
  commit: boolean;
}

/** Records every write instead of framing it onto a channel. */
class RecordingHe extends CompxHeKeyboard {
  writes: Rec[] = [];
  /** Pages that accept the frame but report failure, to drive the abort path. */
  refuse = new Set<number>();

  // The real value is 30ms per write to keep the firmware from wedging its
  // endpoint; an 8-page batch would make these tests take seconds.
  protected readonly settleMs = 0;

  // Pinned so no firmware read is needed. travelMultiplier() maps the raw
  // uint16 firmware version to 10 / 100 / 200; an R85HE on fw v5.11 is 200,
  // i.e. 200 wire units per mm.
  protected override async travelMultiplier(): Promise<number> {
    return 200;
  }

  protected override async writeMagKey(
    page: number,
    slot: number,
    value: number | number[],
    commit: boolean,
  ): Promise<WriteResult> {
    this.writes.push({ page, slot, value, commit });
    return this.refuse.has(page)
      ? { ok: false, verified: 'unverified', error: `page ${page} refused`, frames: [] }
      : { ok: true, verified: 'unverified', frames: [] };
  }

  pagesWritten(): number[] {
    return this.writes.map((w) => w.page);
  }
  valueOn(page: number, slot?: number): number | number[] | undefined {
    return this.writes.find((w) => w.page === page && (slot === undefined || w.slot === slot))
      ?.value;
  }
}

function driver(): RecordingHe {
  return new RecordingHe({
    descriptor: ATTACK_SHARK_R85HE,
    // Every method that would touch it is overridden.
    channel: null as never,
    onWarning: () => undefined,
  });
}

/** Two real keys from the shipped R85HE matrix, so slots are not invented. */
const layout = ATTACK_SHARK_R85HE.spec.keyMatrix!.layout!.filter((e) => e.slot !== undefined);
const KEY = layout[20]!;
const PARTNER = layout[21]!;

const settings = (over: Partial<MagneticKeySettings> = {}): MagneticKeySettings => ({
  row: KEY.row,
  col: KEY.col,
  actuationMm: 1.5,
  rapidTrigger: false,
  ...over,
});

let d: RecordingHe;
beforeEach(() => {
  d = driver();
});

describe('mode byte (page 7)', () => {
  it('packs mode in the low nibble, RT in bit 7, full-bottom-out in bit 6', async () => {
    await d.setMagneticKey(settings({ mode: 'dks', rapidTrigger: true, fullBottomOut: true }));
    // dks = 2, | 0x80 | 0x40 = 0xC2
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0xc2);
  });

  it('writes a bare 0 for a plain normal key', async () => {
    await d.setMagneticKey(settings({ mode: 'normal' }));
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x00);
  });

  it('packs snap without RT as 0x07', async () => {
    await d.setMagneticKey(settings({ mode: 'snap', rapidTrigger: false }));
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x07);
  });

  it('writes every snap-tap key as 7, the one value the firmware acts on', async () => {
    // qmk.top also names 8-10 (who wins while both are held). An R85HE stored
    // them and ignored them, so nothing writes them any more.
    await d.setMagneticKey(settings({ mode: 'snap', rapidTrigger: true }));
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x87);
  });

  it("re-sends a snap-tap key's mode even when it reads back unchanged", async () => {
    // A key the board holds at 8-10 reads back as snap-tap, so comparing with
    // the previous state would never rewrite it to 7.
    const was = settings({ mode: 'snap', socdPartner: { row: PARTNER.row, col: PARTNER.col } });
    await d.setMagneticKeys([{ ...was, actuationMm: 2 }], [was]);
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x07);
  });

  it('defaults a missing mode to normal rather than writing undefined', async () => {
    await d.setMagneticKey(settings());
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x00);
  });

  it('keeps RT armed in the mode byte, not on a page of its own', async () => {
    // Writing the bare mode would clear the key's RT flag, which is why the
    // bit has to be packed in here.
    await d.setMagneticKey(settings({ mode: 'normal', rapidTrigger: true }));
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x80);
  });
});

describe('rapid-trigger sensitivity pages', () => {
  it('writes pages 2 and 3 whenever a value is given', async () => {
    await d.setMagneticKey(settings({ rapidTrigger: true, rtPressMm: 0.5, rtReleaseMm: 0.3 }));
    expect(d.pagesWritten()).toContain(PAGE.RT_PRESS);
    expect(d.pagesWritten()).toContain(PAGE.RT_RELEASE);
  });

  it('writes them with rapid trigger off too', async () => {
    // They used to be gated on the flag, which made "Restore all keys to
    // default" a lie: it sets RT off, so the two pages were skipped and the
    // board kept whatever sensitivity it held while the panel showed 0.2 mm.
    await d.setMagneticKey(settings({ rapidTrigger: false, rtPressMm: 0.2, rtReleaseMm: 0.2 }));
    expect(d.valueOn(PAGE.RT_PRESS, KEY.slot)).toBe(40); // 0.2 mm * 200
    expect(d.valueOn(PAGE.RT_RELEASE, KEY.slot)).toBe(40);
  });

  it('omits them when the key carries no value', async () => {
    await d.setMagneticKey(settings({ rapidTrigger: true }));
    expect(d.pagesWritten()).not.toContain(PAGE.RT_PRESS);
    expect(d.pagesWritten()).not.toContain(PAGE.RT_RELEASE);
  });
});

describe('SOCD / snap-tap pairing (page 9)', () => {
  const pairWith = (k: { row: number; col: number }) => ({ row: k.row, col: k.col });
  const other = layout[22]!;

  it("writes only this key's own half — never the partner's", async () => {
    // It used to write the partner's page 9 and mode byte too, stamping THIS
    // key's rapid-trigger bit over the partner's own settings. A pairing is
    // now a batch with both keys in it (see the next test).
    await d.setMagneticKey(settings({ mode: 'snap', socdPartner: pairWith(PARTNER) }));
    expect(d.writes.filter((w) => w.page === PAGE.SNAP)).toEqual([
      expect.objectContaining({ slot: KEY.slot, value: PARTNER.slot }),
    ]);
    expect(d.writes.some((w) => w.slot === PARTNER.slot)).toBe(false);
  });

  it('pairs as one batch, each key keeping its own bits', async () => {
    const r = await d.setMagneticKeys([
      settings({ mode: 'snap', socdPartner: pairWith(PARTNER), rapidTrigger: true }),
      {
        ...settings({ mode: 'snap', socdPartner: pairWith(KEY), fullBottomOut: true }),
        row: PARTNER.row,
        col: PARTNER.col,
      },
    ]);
    expect(r.ok).toBe(true);
    expect(d.valueOn(PAGE.MODES, KEY.slot)).toBe(0x87);
    expect(d.valueOn(PAGE.MODES, PARTNER.slot)).toBe(0x47);
    expect(d.valueOn(PAGE.SNAP, KEY.slot)).toBe(PARTNER.slot);
    expect(d.valueOn(PAGE.SNAP, PARTNER.slot)).toBe(KEY.slot);
  });

  it('refuses a batch whose two halves disagree, before writing anything', async () => {
    const back = (partner: { row: number; col: number }, over = {}) => ({
      ...settings({ mode: 'snap', socdPartner: partner, ...over }),
      row: PARTNER.row,
      col: PARTNER.col,
    });
    for (const batch of [
      // D does not name A back
      [settings({ mode: 'snap', socdPartner: pairWith(PARTNER) }), back(pairWith(other))],
      // D is not snap-tap at all
      [
        settings({ mode: 'snap', socdPartner: pairWith(PARTNER) }),
        { ...settings(), row: PARTNER.row, col: PARTNER.col },
      ],
    ]) {
      d.writes = [];
      const r = await d.setMagneticKeys(batch);
      expect(r.ok).toBe(false);
      expect(d.writes).toHaveLength(0);
    }
  });

  it('clears the pairing with 0xFF, never 0, when leaving snap', async () => {
    // Writing 0 would point the key at slot 0 (Esc on the R85HE) instead of
    // unpairing it.
    await d.setMagneticKey(settings({ mode: 'normal' }));
    expect(d.valueOn(PAGE.SNAP, KEY.slot)).toBe(SOCD_NO_PARTNER);
    expect(d.valueOn(PAGE.SNAP, KEY.slot)).not.toBe(0);
  });

  it('writes page 9 again only when the partner changed', async () => {
    const was = settings({ mode: 'snap', socdPartner: pairWith(PARTNER) });
    await d.setMagneticKeys([{ ...was, actuationMm: 2 }], [was]);
    expect(d.pagesWritten()).not.toContain(PAGE.SNAP);

    await d.setMagneticKeys([settings({ mode: 'snap', socdPartner: pairWith(other) })], [was]);
    expect(d.valueOn(PAGE.SNAP, KEY.slot)).toBe(other.slot);
  });

  it('refuses a partner that is not in the matrix, or the key itself', async () => {
    for (const partner of [{ row: 99, col: 99 }, pairWith(KEY)]) {
      d.writes = [];
      const r = await d.setMagneticKey(settings({ mode: 'snap', socdPartner: partner }));
      expect(r.ok).toBe(false);
      expect(d.writes).toHaveLength(0);
    }
  });
});

describe('commit flag', () => {
  it('sets commit on exactly one write, and it is the last', async () => {
    // The batch is built first precisely so commit lands on the genuinely
    // final frame rather than on whichever page happened to be in a list.
    await d.setMagneticKey(
      settings({
        mode: 'dks',
        rapidTrigger: true,
        rtPressMm: 0.4,
        rtReleaseMm: 0.4,
        releaseMm: 1.2,
        deadZoneMm: 0.1,
        deadZoneBottomMm: 0.1,
        dksPointMm: 0.7,
      }),
    );

    const committed = d.writes.filter((w) => w.commit);
    expect(committed).toHaveLength(1);
    expect(d.writes[d.writes.length - 1]!.commit).toBe(true);
    // dks appends pages 4 and 10 AFTER the mode byte, so a naive
    // commit-on-mode-write would have fired too early.
    expect(d.pagesWritten()).toContain(PAGE.DKS_FLAGS);
  });
});

describe('mm to wire units', () => {
  it('scales by 200 units per mm', async () => {
    await d.setMagneticKey(settings({ actuationMm: 1.5 }));
    expect(d.valueOn(PAGE.TRAVEL, KEY.slot)).toBe(300);
  });

  it('writes each travel page it is given a value for', async () => {
    await d.setMagneticKey(
      settings({ actuationMm: 1, releaseMm: 0.8, deadZoneMm: 0.2, deadZoneBottomMm: 0.15 }),
    );
    expect(d.valueOn(PAGE.TRAVEL, KEY.slot)).toBe(200);
    expect(d.valueOn(PAGE.RELEASE, KEY.slot)).toBe(160);
    expect(d.valueOn(PAGE.DEADZONE_TOP, KEY.slot)).toBe(40);
    expect(d.valueOn(PAGE.DEADZONE_BOTTOM, KEY.slot)).toBe(30);
  });

  it('clamps actuation to the 0.1-4 mm the wire allows', async () => {
    // A slider cannot reach these, but a stored profile from another board
    // or a hand-edited settings file can.
    await d.setMagneticKey(settings({ actuationMm: 99 }));
    expect(d.valueOn(PAGE.TRAVEL, KEY.slot)).toBe(800); // 4 mm * 200

    const e = driver();
    await e.setMagneticKey(settings({ actuationMm: 0 }));
    expect(e.valueOn(PAGE.TRAVEL, KEY.slot)).toBe(20); // 0.1 mm * 200
  });

  it('lets rapid trigger reach one wire unit, and a dead zone reach zero', async () => {
    // The floor used to be a single 0.1 mm for every page, which silently
    // turned the finest rapid trigger the hardware can express into twenty
    // times that, and "no dead zone" into a 0.1 mm one.
    await d.setMagneticKey(
      settings({ rtPressMm: 0.005, rtReleaseMm: 0.005, deadZoneMm: 0, deadZoneBottomMm: 0 }),
    );
    expect(d.valueOn(PAGE.RT_PRESS, KEY.slot)).toBe(1); // 0.005 mm * 200
    expect(d.valueOn(PAGE.RT_RELEASE, KEY.slot)).toBe(1);
    expect(d.valueOn(PAGE.DEADZONE_TOP, KEY.slot)).toBe(0);
    expect(d.valueOn(PAGE.DEADZONE_BOTTOM, KEY.slot)).toBe(0);
  });
  it('omits a travel page whose value is undefined', async () => {
    await d.setMagneticKey(settings({ actuationMm: 1 }));
    expect(d.pagesWritten()).not.toContain(PAGE.RELEASE);
    expect(d.pagesWritten()).not.toContain(PAGE.DEADZONE_TOP);
  });
});

describe('mod-tap hold time (page 5)', () => {
  it('stores milliseconds divided by ten', async () => {
    await d.setMagneticKey(settings({ mode: 'mt', mtHoldMs: 250 }));
    expect(d.valueOn(PAGE.MT, KEY.slot)).toBe(25);
  });

  it('is not written without a hold time', async () => {
    await d.setMagneticKey(settings({ mode: 'mt' }));
    expect(d.pagesWritten()).not.toContain(PAGE.MT);
  });

  it('is not written for a non-mod-tap mode', async () => {
    await d.setMagneticKey(settings({ mode: 'normal', mtHoldMs: 250 }));
    expect(d.pagesWritten()).not.toContain(PAGE.MT);
  });

  it('clamps to what one byte can say, never wrapping or reaching 0', async () => {
    // Masking made 3 s wrap round to 0.44 s; 0 is no hold time at all.
    await d.setMagneticKey(settings({ mode: 'mt', mtHoldMs: 3000 }));
    expect(d.valueOn(PAGE.MT, KEY.slot)).toBe(255);
    d.writes = [];
    await d.setMagneticKey(settings({ mode: 'mt', mtHoldMs: 1 }));
    expect(d.valueOn(PAGE.MT, KEY.slot)).toBe(1);
  });

  it('is not re-sent when the hold time did not move', async () => {
    const was = settings({ mode: 'mt', mtHoldMs: 200 });
    await d.setMagneticKeys([{ ...was, actuationMm: 2 }], [was]);
    expect(d.pagesWritten()).not.toContain(PAGE.MT);
  });
});

describe('DKS zone flags (page 8)', () => {
  it('writes four bytes only for a dks key', async () => {
    await d.setMagneticKey(settings({ mode: 'dks' }));
    const v = d.valueOn(PAGE.DKS_FLAGS, KEY.slot);
    expect(Array.isArray(v)).toBe(true);
    expect(v as number[]).toHaveLength(4);
  });

  it("writes them to page 8, as the vendor's own capture does", async () => {
    // session-r85he.jsonl, step 09_mode_dks: four actions, one tap per point,
    // is `01 04 10 40` on page 8. Page 10 — written before — changed nothing.
    await d.setMagneticKey(
      settings({
        mode: 'dks',
        dksZones: [
          { a: 'A', b: null, c: null, d: null },
          { a: null, b: 'B', c: null, d: null },
          { a: null, b: null, c: 'C', d: null },
          { a: null, b: null, c: null, d: 'D' },
        ],
      }),
    );
    expect(d.valueOn(PAGE.DKS_FLAGS, KEY.slot)).toEqual([0x01, 0x04, 0x10, 0x40]);
    expect(d.pagesWritten()).not.toContain(10);
  });

  it('is not written for a key in another mode', async () => {
    await d.setMagneticKey(settings({ mode: 'normal' }));
    expect(d.pagesWritten()).not.toContain(PAGE.DKS_FLAGS);
  });
});

describe('failure handling', () => {
  it('rejects a key that is not in the matrix, with no writes at all', async () => {
    const r = await d.setMagneticKey(settings({ row: 99, col: 99 }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in matrix/);
    expect(d.writes).toHaveLength(0);
  });

  it('stops the batch at a refused page and reports the failure', async () => {
    d.refuse.add(PAGE.RELEASE);
    const r = await d.setMagneticKey(settings({ actuationMm: 1, releaseMm: 0.8 }));

    expect(r.ok).toBe(false);
    // Everything up to and including the refusal was attempted...
    expect(d.pagesWritten()).toContain(PAGE.RELEASE);
    // ...and nothing after it. Page 9's unpair write is last in the batch.
    expect(d.pagesWritten()).not.toContain(PAGE.SNAP);
  });

  it('aborts setMagneticKeys on the first failing key', async () => {
    d.refuse.add(PAGE.MODES);
    const r = await d.setMagneticKeys([
      settings(),
      settings({ row: PARTNER.row, col: PARTNER.col }),
    ]);

    expect(r.ok).toBe(false);
    // The second key must never be touched.
    expect(d.writes.every((w) => w.slot !== PARTNER.slot)).toBe(true);
  });
});

describe('setMagneticKeys', () => {
  it('writes every key in the selection', async () => {
    const r = await d.setMagneticKeys([
      settings(),
      settings({ row: PARTNER.row, col: PARTNER.col }),
    ]);
    expect(r.ok).toBe(true);
    const slots = new Set(d.writes.map((w) => w.slot));
    expect(slots.has(KEY.slot!)).toBe(true);
    expect(slots.has(PARTNER.slot!)).toBe(true);
  });

  /**
   * A bulk write is ONE operation, so it commits once — on its genuinely last
   * frame. It used to delegate to `setMagneticKey` per key, which committed per
   * key: 79 commits for "restore every key to default", which is both why that
   * took over a minute and why it could stop partway on a firmware whose notes
   * warn about bursts. A batch that stops partway leaves half the board on the
   * old settings — reported as "I restored the defaults and every key ended up
   * different".
   */
  it('commits exactly once, on the last frame', async () => {
    await d.setMagneticKeys([settings(), settings({ row: PARTNER.row, col: PARTNER.col })]);
    const commits = d.writes.filter((w) => w.commit);
    expect(commits).toHaveLength(1);
    expect(d.writes[d.writes.length - 1]!.commit).toBe(true);
  });

  it('still commits once for a board-sized batch', async () => {
    await d.setMagneticKeys(
      layout.map((e) => ({ row: e.row, col: e.col, actuationMm: 1.5, rapidTrigger: false })),
    );
    expect(d.writes.filter((w) => w.commit)).toHaveLength(1);
    // Every key reached, none of them committed on its own.
    expect(new Set(d.writes.map((w) => w.slot)).size).toBe(layout.length);
  });

  /**
   * Only what changed goes on the wire.
   *
   * Every setting used to be written every time — eight frames per key, each
   * paced by `settleMs` on top of a feature transaction — so resetting a large
   * selection was hundreds of frames and took over a minute. The vendor writes
   * only the pages that differ; given what the caller last read, so can we.
   */
  describe('with the previous state', () => {
    const now = settings({ actuationMm: 1.5, releaseMm: 1.5, deadZoneMm: 0.3 });

    it('sends nothing for a key that is already exactly right', async () => {
      const r = await d.setMagneticKeys([now], [now]);
      expect(r.ok).toBe(true);
      expect(d.writes).toHaveLength(0);
    });

    it('sends only the page that moved', async () => {
      await d.setMagneticKeys([{ ...now, actuationMm: 2 }], [now]);
      expect(d.pagesWritten()).toEqual([PAGE.TRAVEL]);
      expect(d.writes[0]!.commit).toBe(true);
    });

    it('counts a mode or rapid-trigger change as the mode page alone', async () => {
      await d.setMagneticKeys([{ ...now, rapidTrigger: true }], [now]);
      expect(d.pagesWritten()).toEqual([PAGE.MODES]);
    });

    it('does not re-send a value that only differs by float noise', async () => {
      // 1.5 and 1.4999999 are the same wire unit at x200. A float that has been
      // through the UI and back must not read as a change.
      await d.setMagneticKeys([{ ...now, actuationMm: 1.5000001 }], [now]);
      expect(d.writes).toHaveLength(0);
    });

    it('leaves page 9 alone unless the key is leaving snap mode', async () => {
      // The unpair write fired on every write of every key, on a board where
      // nothing uses snap — 79 frames of a full restore, for nothing.
      await d.setMagneticKeys([{ ...now, actuationMm: 2 }], [now]);
      expect(d.pagesWritten()).not.toContain(PAGE.SNAP);
      d.writes = [];
      await d.setMagneticKeys([now], [{ ...now, mode: 'snap' }]);
      expect(d.pagesWritten()).toContain(PAGE.SNAP);
    });

    it('writes everything when no previous state is given', async () => {
      await d.setMagneticKeys([now]);
      expect(d.pagesWritten()).toContain(PAGE.TRAVEL);
      expect(d.pagesWritten()).toContain(PAGE.MODES);
      expect(d.pagesWritten()).toContain(PAGE.SNAP);
    });

    it('ignores a previous entry that is about a different key', async () => {
      // Positional, so a mismatched pair would suppress a page the board has
      // not got. Better to write too much than to write too little.
      await d.setMagneticKeys([now], [{ ...now, row: PARTNER.row, col: PARTNER.col }]);
      expect(d.pagesWritten()).toContain(PAGE.TRAVEL);
    });
  });

  it('writes nothing at all when a key is not in the matrix', async () => {
    // Built up front, so a caller's mistake cannot half-write the board.
    const r = await d.setMagneticKeys([settings(), settings({ row: 99, col: 99 })]);
    expect(r.ok).toBe(false);
    expect(d.writes).toHaveLength(0);
  });
});
