/**
 * Dynamic Keystroke (DKS) zone encoding.
 *
 * A DKS key binds up to four separate actions to one physical key, fired at
 * different depths of the same press. The vendor's own wording:
 * "单个按键实现四种功能，可以根据不同的按压和松开程度绑定1至4种功能" — one key
 * performs four functions, bound to different press and release depths.
 *
 * There are four **trigger points** along the stroke:
 *
 *   A  press start    (the DKS actuation point, magnetic page 4)
 *   B  press end      (bottom of the stroke)
 *   C  release start  (bottom, coming back up)
 *   D  release end    (the actuation point again, released)
 *
 * Magnetic page 8 holds **4 bytes per key** — one byte per zone. Each byte
 * packs four 2-bit fields, one per trigger point:
 *
 *   byte = a | (b << 2) | (c << 4) | (d << 6)
 *
 * A field is 0 for "nothing at this point", 1 for "fire here", and 2/3 for
 * "held from here to a later point". Which later point depends on the
 * neighbouring fields, so the byte is a small run-length encoding rather than
 * four independent values:
 *
 *   a=1 "A"      fire at press start          a=2 "A-BS"  hold A through B
 *   a=3,b=2      "A-CS"  hold A through C     a=3,b=3,c=2 "A-DS" hold A through D
 *   b=1 "B"      fire at press end            b=2 "B-CS"  hold B through C
 *   b=3,c=2      "B-DS"  hold B through D
 *   c=1 "C"      fire at release start        c=2/3 "C-DS" hold C through D
 *   d=1 "D"      fire at release end
 *
 * Ported verbatim from qmk.top's `ws` (unpack) and `Lu` (pack) — see
 * `npm run extract:qmk`. `provenance: ported-from-vendor`.
 */

/** What one trigger point does in a zone. `null` = nothing happens there. */
export type DksAction = 'A' | 'A-BS' | 'A-CS' | 'A-DS' | 'B' | 'B-CS' | 'B-DS' | 'C' | 'C-DS' | 'D';

export interface DksZone {
  /** press start */
  a: DksAction | null;
  /** press end */
  b: DksAction | null;
  /** release start */
  c: DksAction | null;
  /** release end */
  d: DksAction | null;
}

export const EMPTY_DKS_ZONE: DksZone = { a: null, b: null, c: null, d: null };

/**
 * Unpack a page-8 zone byte. Returns null for a bit pattern the firmware would
 * not have produced — the vendor treats those as "not a DKS zone" rather than
 * guessing, and so do we.
 */
export function decodeDksZone(byte: number): DksZone | null {
  const a = byte & 3;
  const b = (byte & 12) >> 2;
  const c = (byte & 48) >> 4;
  const d = (byte & 192) >> 6;

  // validity rules, verbatim from the vendor's `ws`
  if (d > 1 || c > 2 || (b === 3 && c < 2) || (a === 3 && b < 2)) return null;

  let A: DksAction | null = null;
  let B: DksAction | null = null;
  let C: DksAction | null = null;
  const D: DksAction | null = d === 1 ? 'D' : null;

  if (a === 1) A = 'A';
  if (a === 2) A = 'A-BS';
  if (b === 1) B = 'B';
  if (b === 2) B = 'B-CS';
  if (c === 1) C = 'C';
  if (c === 2 || c === 3) C = 'C-DS';
  // a span that swallows the points it covers clears them
  if (b === 3 && c === 2) {
    B = 'B-DS';
    C = null;
  }
  if (a === 3) {
    if (b === 2) {
      A = 'A-CS';
      B = null;
    }
    if (b === 3 && c === 2) {
      A = 'A-DS';
      B = null;
      C = null;
    }
  }
  return { a: A, b: B, c: C, d: D };
}

/**
 * Pack a zone back into its byte. Returns null if the combination is not one
 * the firmware accepts (the vendor round-trips through the unpacker to check,
 * and so does this).
 */
export function encodeDksZone(z: DksZone): number | null {
  const a = z.a === null ? 0 : z.a === 'A' ? 1 : z.a === 'A-BS' ? 2 : 3;
  const b =
    z.a === 'A-DS'
      ? 3
      : z.a === 'A-CS'
        ? 2
        : z.b === null
          ? 0
          : z.b === 'B'
            ? 1
            : z.b === 'B-CS'
              ? 2
              : 3;
  const c = z.a === 'A-DS' || z.b === 'B-DS' || z.c === 'C-DS' ? 2 : z.c === null ? 0 : 1;
  const d = z.d === 'D' ? 1 : 0;
  const byte = a | (b << 2) | (c << 4) | (d << 6);
  return decodeDksZone(byte) ? byte : null;
}

/** True when a zone does nothing at all — the firmware default. */
export const isEmptyDksZone = (z: DksZone): boolean =>
  z.a === null && z.b === null && z.c === null && z.d === null;

/** The four zone bytes for a key, defaulting to the vendor's `[0,0,0,0]`. */
export function dksZoneBytes(zones: DksZone[] | undefined): number[] {
  const out = [0, 0, 0, 0];
  if (!zones) return out;
  for (let i = 0; i < 4; i++) {
    const z = zones[i];
    if (!z) continue;
    out[i] = encodeDksZone(z) ?? 0;
  }
  return out;
}

/** Decode a key's four zone bytes. */
export function dksZonesFrom(bytes: number[]): DksZone[] {
  return [0, 1, 2, 3].map((i) => decodeDksZone(bytes[i] ?? 0) ?? { ...EMPTY_DKS_ZONE });
}
