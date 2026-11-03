/**
 * Which `SET_KEYMATRIX` zone carries what, for the keys that use more than
 * one — and the record SharkDeck keeps of them (`KeyZoneBindings`).
 *
 * A key's binding lives in zone 0. A DKS key adds actions 2-4 in zones 1-3
 * and keeps its own binding as action 1. A MOD-TAP key is the other way
 * round from what the code first assumed: the firmware fires zone 0 on a HOLD
 * and zone 1 on a TAP. Settled on an R85HE on 2026-10-09 (`verify-he-writes`,
 * step `mt`): with A's own binding left in zone 0 and Left Ctrl written to
 * zone 1, tapping A sent Ctrl and holding it repeated `a`.
 *
 * So a mod-tap key's own binding — its tap — moves to zone 1 while it is
 * mod-tap, and its hold takes zone 0. That is the one time SharkDeck writes
 * over a key's own binding, and why leaving mod-tap has to put it back (see
 * `CompxHeKeyboard`). `provenance: ported-from-vendor` for the frames (the
 * vendor's `setDKSKeySimple` loop); the zone ORDER is the hardware check
 * above, over a capture that had been read the other way round.
 */

/** The zone a mod-tap key's HOLD binding is written to. */
export const MT_HOLD_ZONE = 0;
/** The zone a mod-tap key's TAP — its own binding, moved — is written to. */
export const MT_TAP_ZONE = 1;

/** One key's zones as recorded: an action per zone, '' for nothing bound,
 *  null for a zone that was left as the board had it. */
export type ZoneEntry = ReadonlyArray<string | null>;

/**
 * A record entry that put a mod-tap hold in zone 0 — the only kind of entry
 * with anything written in zone 0 — and so carries the key's own binding, its
 * tap, in zone 1. A DKS entry leaves zone 0 null.
 */
export function isModTapEntry(z: ZoneEntry | null | undefined): boolean {
  return (
    !!z &&
    typeof z[MT_HOLD_ZONE] === 'string' &&
    z[MT_HOLD_ZONE] !== '' &&
    typeof z[MT_TAP_ZONE] === 'string' &&
    z[MT_TAP_ZONE] !== ''
  );
}

/**
 * The hold of a mod-tap entry recorded the old way round, `[null, hold]` —
 * zone 0 left as the key's own binding, the hold in zone 1. The board treats
 * that as tap = hold and hold = the key itself, which is the inverted key the
 * hardware check found. Null for anything else.
 */
export function legacyModTapHold(z: ZoneEntry | null | undefined): string | null {
  if (!z || z.length !== 2 || z[0] !== null) return null;
  const hold = z[1];
  return typeof hold === 'string' && hold !== '' ? hold : null;
}

/**
 * A binding's four quad bytes as the action `SET_KEYMATRIX` takes: the HID
 * usage's hex when the quad is a plain key (`[0, hi, lo, 0]`), the 8-digit
 * quad itself for anything else (a consumer usage, a lighting control).
 */
export function actionOfQuad(raw: readonly number[]): string {
  const b = [0, 1, 2, 3].map((i) => (raw[i] ?? 0) & 0xff);
  if (b[0] === 0 && b[3] === 0) {
    return ((b[1]! << 8) | b[2]!).toString(16).padStart(2, '0');
  }
  return b.map((n) => n.toString(16).padStart(2, '0')).join('');
}
