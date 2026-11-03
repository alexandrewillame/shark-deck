import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';
import { CompxHeKeyboard } from './compx-he-keyboard';

/**
 * The magnetic READ path had no coverage at all — every other test in this
 * directory records writes. That gap is why three decode defects shipped
 * together: a page-0 zero became a 2.5 mm actuation while the same zero on
 * page 1 became `undefined` (so one key read as having two unrelated depths,
 * which the Actuation tab could only draw as "set separately"); a chunk that
 * came back short shifted every slot after it onto another key's bytes; and a
 * page that failed half way through returned a truncated array whose tail
 * decoded as zeros.
 *
 * The fixture is this repo's one real capture: a read-only page sweep of an
 * R85HE on firmware 1297, taken with `npm run snapshot:kb`. Its `rawPages` are
 * exactly what `readMagnetismPage` consumes — "64 data bytes per chunk from
 * frame[1]", in the file's own words — so replaying them through a fake
 * channel runs the real decoder over real bytes.
 */

interface Snapshot {
  device: { firmwareRaw?: number; travelMultiplier?: number };
  rawPages: Record<string, string[]>;
}

const SNAPSHOT: Snapshot = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../../docs/reverse-engineering/kb-snapshot-2026-09-05T04-30-15-131Z.json',
    ),
    'utf8',
  ),
);

/** `compx-fea` lays args from byte 2 (see hid/frame.ts): page, 1, chunk. */
const queryOf = (f: Uint8Array) => ({ page: f[2] ?? -1, chunk: f[4] ?? -1 });

type Fault = { page: number; chunk?: number; kind: 'drop' | 'short' | 'zero' };
const hits = (f: Fault | undefined, page: number, chunk: number, kind: Fault['kind']) =>
  !!f && f.kind === kind && f.page === page && (f.chunk === undefined || f.chunk === chunk);

class ReplayHe extends CompxHeKeyboard {
  protected readonly settleMs = 0;
  protected override async travelMultiplier(): Promise<number> {
    return SNAPSHOT.device.travelMultiplier ?? 200;
  }
  /** `readMagnetismPage` is protected; this is the test's way in. */
  page(n: number): Promise<number[] | null> {
    return this.readMagnetismPage(n);
  }
}

function driver(fault?: Fault): ReplayHe {
  let q = { page: -1, chunk: -1 };
  const io = {
    write: async (f: Uint8Array) => void (q = queryOf(f)),
    read: async (): Promise<Buffer | null> => {
      const hex = SNAPSHOT.rawPages[`page_${q.page}`]?.[q.chunk];
      // 'ECHO' is how the capture script records a chunk the firmware did not
      // answer — the same thing `isEchoOf` catches on the wire.
      if (hex === undefined || hex === 'ECHO') return null;
      if (hits(fault, q.page, q.chunk, 'drop')) return null;
      // A page the firmware answers with nothing set — "not configured",
      // which is different from "did not answer".
      if (hits(fault, q.page, q.chunk, 'zero')) return Buffer.alloc(65);
      // The file stores the 64 DATA bytes, space-separated; the wire frame
      // carries a leading report id, which MM_REPLY_OFFSET skips.
      const full = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from(hex.replace(/\s+/g, ''), 'hex'),
      ]);
      return hits(fault, q.page, q.chunk, 'short') ? full.subarray(0, full.length - 8) : full;
    },
  };
  return new ReplayHe({
    descriptor: ATTACK_SHARK_R85HE,
    channel: {
      transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io),
    } as never,
    onWarning: () => undefined,
  });
}

/** The board this fixture came from; slots are the firmware's, not layout order. */
const SLOT = { UNTOUCHED: 0, SHIFT: 4, A: 9, W: 14, S: 15, D: 21, EMPTY: 10 };

describe('magnetic page decode, against a real R85HE capture', () => {
  it('is the capture it claims to be', () => {
    expect(SNAPSHOT.device.firmwareRaw, 'fixture is not the fw-1297 board').toBe(1297);
    expect(SNAPSHOT.device.travelMultiplier).toBe(200);
  });

  it('decodes travel and release as 16-bit little-endian at x200', async () => {
    const d = driver();
    const travel = (await d.page(0))!;
    const release = (await d.page(1))!;
    expect(travel[SLOT.UNTOUCHED]).toBe(400); // 2.0 mm
    expect(release[SLOT.UNTOUCHED]).toBe(560); // 2.8 mm
    expect(travel[SLOT.SHIFT]).toBe(200); // 1.0 mm
    // The four keys the board's owner had actually configured.
    for (const s of [SLOT.A, SLOT.W, SLOT.S, SLOT.D]) {
      expect(travel[s], `slot ${s} travel`).toBe(20); // 0.1 mm
      expect(release[s], `slot ${s} release`).toBe(20);
    }
  });

  it('decodes a 1-byte-per-key page at its own width', async () => {
    // Page 6 (bottom dead zone) is 4 chunks = 2 bytes/key; page 7 (modes) is
    // 2 chunks = 1 byte/key. Getting `chunks / 2` wrong pairs adjacent keys.
    const dz = (await driver().page(6))!;
    const modes = (await driver().page(7))!;
    expect(dz[SLOT.UNTOUCHED]).toBe(60); // 0.3 mm — the vendor's own default
    expect(dz.length).toBe(128);
    expect(modes.length).toBe(128);
    expect(modes.every((m) => m === 0)).toBe(true); // all normal, RT off
  });

  it('refuses a page whose chunk came back short', async () => {
    // The decode is positional: a short chunk does not lose the tail, it
    // shifts every slot after it onto another key's bytes. Refusing the page
    // shows defaults, which reads as "we did not get it" rather than as
    // someone else's settings.
    expect(await driver({ page: 0, chunk: 1, kind: 'short' }).page(0)).toBeNull();
  });

  it('refuses a page that failed part way through', async () => {
    expect(await driver({ page: 0, chunk: 2, kind: 'drop' }).page(0)).toBeNull();
  });

  it('treats an unset release page as linked, not as a second depth', async () => {
    // The asymmetric-fallback bug. A zero on page 0 fell back to the table
    // default (2.5 mm) while the same zero on page 1 fell back to
    // `undefined`, so a board that has never had its release points written
    // came out as "2.5 mm actuate, release unknown" — two different things,
    // which the Actuation tab could only draw as "set separately".
    const keys = await driver({ page: 1, kind: 'zero' }).readMagnetic();
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.releaseMm, `${k.row},${k.col} has no release point`).toBeDefined();
      expect(k.releaseMm, `${k.row},${k.col} is not linked`).toBe(k.actuationMm);
    }
  });

  /**
   * Zero is a dead zone, not the absence of one.
   *
   * The two dead-zone ranges start at 0 and 0 means "none" — the write path
   * has always had a floor of `deadzone.min` for exactly that reason. The read
   * ended in `|| undefined`, so a dead zone deliberately set to 0 came back as
   * "no value", the panel substituted the 0.3 mm table default, and leaving the
   * tab and returning appeared to undo a change the board had accepted (and
   * that qmk.top could see).
   */
  it('reads a dead zone of zero as zero, not as unset', async () => {
    for (const page of [251, 6]) {
      const keys = await driver({ page, kind: 'zero' }).readMagnetic();
      const field = page === 251 ? 'deadZoneMm' : 'deadZoneBottomMm';
      for (const k of keys) {
        expect(k[field], `${k.row},${k.col} page ${page}`).toBe(0);
      }
    }
  });

  it('still leaves a dead zone unset when the page could not be read', async () => {
    // The distinction the `|| undefined` collapsed: a failed read has no value
    // to show and must fall back to the default, a zero has one and must not.
    const keys = await driver({ page: 251, chunk: 0, kind: 'drop' }).readMagnetic();
    for (const k of keys) expect(k.deadZoneMm).toBeUndefined();
  });

  it('reads the configured keys back as the owner set them', async () => {
    const keys = await driver().readMagnetic();
    const layout = ATTACK_SHARK_R85HE.spec.keyMatrix!.layout!;
    for (const slot of [SLOT.A, SLOT.W, SLOT.S, SLOT.D]) {
      const e = layout.find((x) => x.slot === slot)!;
      const k = keys.find((x) => x.row === e.row && x.col === e.col)!;
      expect(k.actuationMm, `${e.label} actuation`).toBe(0.1);
      expect(k.releaseMm, `${e.label} release`).toBe(0.1);
      // Equal on the wire, so nothing in the read can make them look split.
      expect(k.actuationMm).toBe(k.releaseMm);
    }
  });

  /**
   * The read that lies.
   *
   * MODES and TRAVEL between them ARE a key — its mode, its rapid-trigger bit,
   * its actuation point. When either page failed, `?? []` turned "did not
   * answer" into "empty page", every slot decoded to the 2.5 mm table default
   * in plain normal mode, and the caller received a complete, plausible board
   * that was entirely fabricated.
   *
   * The Actuation tab believed it. Reset one key right after a bulk write —
   * when this endpoint is still busy — and the whole board went uniformly
   * default, taking the user's key groups with it, until they pressed Read
   * device and got a real answer.
   */
  it('reports nothing rather than a board of defaults when MODES will not read', async () => {
    const keys = await driver({ page: 7, kind: 'drop' }).readMagnetic();
    expect(keys).toEqual([]);
  });

  it('reports nothing rather than a board of defaults when TRAVEL will not read', async () => {
    const keys = await driver({ page: 0, kind: 'drop' }).readMagnetic();
    expect(keys).toEqual([]);
  });

  it('still answers when only an OPTIONAL page will not read', async () => {
    // Page 251 is the top dead zone: read for every key, but absent from a
    // key's identity, so losing it must not discard the sweep.
    const keys = await driver({ page: 251, kind: 'drop' }).readMagnetic();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.deadZoneMm === undefined)).toBe(true);
  });

  it('keeps a page that answers with zeros, which is a real setting', async () => {
    // "Answered, and every key is at the default" is a legitimate board state
    // and must NOT be confused with the failure above.
    const keys = await driver({ page: 7, kind: 'zero' }).readMagnetic();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.mode === 'normal' && !k.rapidTrigger)).toBe(true);
  });
});
