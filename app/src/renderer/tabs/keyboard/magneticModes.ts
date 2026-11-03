import { getT, type MessageKey, type TFunc } from '@shared/i18n';
import type { Capability } from '@shared/types/capability';
import type {
  KeyZoneBindingEntry,
  KeyZoneBindings,
  MagneticKeySettings,
  MagneticMode,
} from '@shared/types/keyboard-settings';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { slotOf } from '../../keyLayout';

/**
 * What each key mode is, and how a change of mode becomes writes.
 *
 * The Mode picker used to write the mode byte and nothing else. That is all a
 * mode is for Normal and Toggle, and it is not enough for any of the others:
 *
 *  - **Snap-tap** is a PAIR. Each key names its partner (page 9), and a key
 *    set to snap-tap with no partner is half a pair the firmware ignores.
 *  - **Mod-tap** needs the key to hold, and how long counts as holding.
 *  - **DKS** needs its actions and the depths they fire at.
 *
 * So a change of mode here is a plan: every key whose settings move, each with
 * all of its own settings, built from the board as it stands. Pairing A with D
 * releases A's old partner and D's old one; resetting one key of a pair
 * releases the other; copying a key's settings never copies its partner. The
 * driver writes exactly what a plan says and refuses a batch whose two halves
 * of a pair disagree (`snapPairMismatch` in compx-he-keyboard.ts).
 *
 * Pure, so every one of those rules is tested without a board. What it names
 * (the modes, below) it names by catalogue key, resolved where it is drawn.
 */

export interface KeyRef {
  row: number;
  col: number;
}
export type KeyMap = Readonly<Record<string, MagneticKeySettings>>;
export const keyIdOf = (k: KeyRef): string => `${k.row}:${k.col}`;
const same = (a: KeyRef | null | undefined, b: KeyRef | null | undefined) =>
  !!a && !!b && a.row === b.row && a.col === b.col;

/** The modes as the picker offers them: Toggle is one entry, with a style. */
export type ModeChoice = 'normal' | 'snap' | 'toggle' | 'mt' | 'dks';
export type ToggleStyle = 'hold' | 'repeat';

export function choiceOf(mode: MagneticMode | undefined): ModeChoice {
  if (mode === 'tgl_hold' || mode === 'tgl_dots') return 'toggle';
  return mode ?? 'normal';
}
export const toggleStyleOf = (mode: MagneticMode | undefined): ToggleStyle =>
  mode === 'tgl_dots' ? 'repeat' : 'hold';
export const toggleMode = (style: ToggleStyle): MagneticMode =>
  style === 'repeat' ? 'tgl_dots' : 'tgl_hold';

export interface ModeDef {
  value: ModeChoice;
  labelKey: MessageKey;
  /** What the key does in this mode — at most 25 words (in English; the
   *  test counts them there). */
  tipKey: MessageKey;
  /** The capability a board must declare to be offered it. */
  cap?: Capability;
  /** Writes that have not been confirmed on a board yet: tagged in the picker
   *  and in the mode's panel until a hardware check passes. */
  experimental: boolean;
}

export const MODE_DEFS: readonly ModeDef[] = [
  {
    value: 'normal',
    labelKey: 'act.mode.normal',
    tipKey: 'act.mode.normal.tip',
    experimental: false,
  },
  {
    value: 'snap',
    labelKey: 'act.mode.snap',
    tipKey: 'act.mode.snap.tip',
    cap: 'socd',
    experimental: false,
  },
  {
    value: 'toggle',
    labelKey: 'act.mode.toggle',
    tipKey: 'act.mode.toggle.tip',
    experimental: false,
  },
  {
    value: 'mt',
    labelKey: 'act.mode.mt',
    tipKey: 'act.mode.mt.tip',
    cap: 'modTap',
    // Confirmed on an R85HE, 2026-10-12 (verify-he-writes `mt`), once the
    // zones were the right way round — see shared/key-zones.ts.
    experimental: false,
  },
  {
    value: 'dks',
    labelKey: 'act.mode.dks',
    tipKey: 'act.mode.dks.tip',
    cap: 'dks',
    // Confirmed on an R85HE, 2026-10-09 (verify-he-writes `dks`).
    experimental: false,
  },
];

/** The `SET_KEYMATRIX` zones of a mod-tap key: its HOLD in zone 0 and its own
 *  binding, the TAP, moved to zone 1 — the reverse of what was first assumed,
 *  which a hardware check settled (see shared/key-zones.ts). */
export { MT_HOLD_ZONE, MT_TAP_ZONE } from '@shared/key-zones';

/** Mod-tap hold time: the default, and the range offered. */
export const MT_HOLD = { min: 100, max: 1000, step: 10, default: 200 } as const;
/** Where a new DKS key's first point sits. */
export const DKS_DEFAULT_POINT_MM = 0.7;

/** The modes whose key needs bindings of its own in the key matrix's other
 *  zones — see shared/key-zones.ts. */
export const usesZoneBindings = (mode: MagneticMode | undefined): boolean =>
  mode === 'mt' || mode === 'dks';

/**
 * The zone bindings a saved layout keeps: those of its Mod-tap and DKS keys,
 * from what this computer has written to the board, by position. A key in any
 * other mode has nothing there worth keeping, and a key the record does not
 * know (never set up from here) is left out rather than saved as empty.
 */
export function layoutZoneBindings(
  keys: readonly MagneticKeySettings[],
  layout: KeyLayoutEntry[] | undefined,
  record: KeyZoneBindings | null,
): KeyZoneBindingEntry[] {
  if (!record) return [];
  const out: KeyZoneBindingEntry[] = [];
  for (const k of keys) {
    if (!usesZoneBindings(k.mode)) continue;
    const slot = slotOf(layout, k);
    const zones = slot === null ? undefined : record[slot];
    if (zones?.some((z) => z !== null)) out.push({ row: k.row, col: k.col, zones: [...zones] });
  }
  return out;
}

/** The partner a snap-tap key names, when that key names it back. */
export function partnerOf(map: KeyMap, k: KeyRef): MagneticKeySettings | null {
  const me = map[keyIdOf(k)];
  if (me?.mode !== 'snap' || !me.socdPartner) return null;
  const p = map[keyIdOf(me.socdPartner)];
  return p?.mode === 'snap' && same(p.socdPartner, k) ? p : null;
}

/** A snap-tap key that is not half of a working pair: no partner, or one that
 *  does not name it back. The firmware does nothing with it. */
export function isHalfPair(map: KeyMap, k: KeyRef): boolean {
  return map[keyIdOf(k)]?.mode === 'snap' && !partnerOf(map, k);
}

/** Pairs numbered 1, 2, … in board order, for the badge on each key. */
export function pairNumbers(map: KeyMap, order: readonly KeyRef[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const k of order) {
    const id = keyIdOf(k);
    if (out.has(id)) continue;
    const p = partnerOf(map, k);
    if (!p) continue;
    n++;
    out.set(id, n);
    out.set(keyIdOf(p), n);
  }
  return out;
}

/** A key with its pairing taken off: plain, every other setting kept. */
const released = (k: MagneticKeySettings): MagneticKeySettings => ({
  ...k,
  mode: 'normal',
  socdPartner: null,
});

/**
 * Every key whose settings change, ready for `setMagneticKeys` — in a stable
 * order, the changed keys first and any released partners after them.
 */
export type Plan = MagneticKeySettings[];

/**
 * Finish a set of changes: a key that leaves a pair takes its partner out of
 * the pair too, unless that partner is itself one of the changes. Without this
 * the partner went on naming a key that no longer named it back.
 */
function withPartnersReleased(map: KeyMap, changes: Map<string, MagneticKeySettings>): Plan {
  const extra = new Map<string, MagneticKeySettings>();
  for (const [id, next] of changes) {
    const before = map[id];
    if (before?.mode !== 'snap' || !before.socdPartner) continue;
    if (next.mode === 'snap' && same(next.socdPartner, before.socdPartner)) continue;
    const pid = keyIdOf(before.socdPartner);
    if (changes.has(pid) || extra.has(pid)) continue;
    const partner = map[pid];
    if (partner?.mode === 'snap' && same(partner.socdPartner, before)) {
      extra.set(pid, released(partner));
    }
  }
  return [...changes.values(), ...extra.values()];
}

/** Pair `a` with `b`. Nothing for a key the map has no settings for — a plan
 *  never guesses a key's state.
 *
 *  There is no "who wins" any more: the firmware's own answer is the key
 *  pressed last, and the three other values qmk.top names did nothing on an
 *  R85HE (see `isSnapNum` in compx-he-keyboard.ts). */
export function planPair(map: KeyMap, a: KeyRef, b: KeyRef): Plan {
  const A = map[keyIdOf(a)];
  const B = map[keyIdOf(b)];
  if (!A || !B || same(a, b)) return [];
  const changes = new Map<string, MagneticKeySettings>([
    [keyIdOf(a), { ...A, mode: 'snap', socdPartner: { row: b.row, col: b.col } }],
    [keyIdOf(b), { ...B, mode: 'snap', socdPartner: { row: a.row, col: a.col } }],
  ]);
  return withPartnersReleased(map, changes);
}

/** Take `a` out of its pair — and its partner with it. */
export function planUnpair(map: KeyMap, a: KeyRef): Plan {
  const A = map[keyIdOf(a)];
  if (!A || A.mode !== 'snap') return [];
  return withPartnersReleased(map, new Map([[keyIdOf(a), released(A)]]));
}

/**
 * Put `keys` in `mode` — any mode but snap-tap, which is a pairing
 * (`planPair`). A key leaving a pair releases its partner. A mode that needs
 * values of its own gets the defaults the key does not already have.
 */
export function planModeChange(map: KeyMap, keys: readonly KeyRef[], mode: MagneticMode): Plan {
  if (mode === 'snap') return [];
  const changes = new Map<string, MagneticKeySettings>();
  for (const k of keys) {
    const before = map[keyIdOf(k)];
    if (!before) continue;
    const next: MagneticKeySettings = { ...released(before), mode };
    if (mode === 'mt') next.mtHoldMs = before.mtHoldMs ?? MT_HOLD.default;
    if (mode === 'dks') next.dksPointMm = before.dksPointMm ?? DKS_DEFAULT_POINT_MM;
    changes.set(keyIdOf(k), next);
  }
  return withPartnersReleased(map, changes);
}

/** Put `keys` back to `defaults`, releasing the partners they leave behind. */
export function planReset(
  map: KeyMap,
  keys: readonly KeyRef[],
  defaults: (k: KeyRef) => MagneticKeySettings,
): Plan {
  const changes = new Map<string, MagneticKeySettings>();
  for (const k of keys) changes.set(keyIdOf(k), defaults(k));
  return withPartnersReleased(map, changes);
}

/**
 * What a key takes from another's settings: everything but what belongs to
 * the source alone. A snap-tap partner is the source's own; mod-tap and DKS
 * keys need bindings of their own that a copy cannot carry. Those land as a
 * plain key with the source's travel, rather than half a pair or a mod-tap
 * with nothing to hold.
 */
export function settingsForCopy(src: MagneticKeySettings, to: KeyRef): MagneticKeySettings {
  const out: MagneticKeySettings = { ...src, row: to.row, col: to.col };
  if (src.mode === 'snap' || src.mode === 'mt' || src.mode === 'dks') {
    out.mode = 'normal';
    out.socdPartner = null;
    out.mtHoldMs = undefined;
    out.dksPointMm = undefined;
    out.dksZones = undefined;
  }
  return out;
}

/** Give each of `targets` the settings of `src` (see `settingsForCopy`). */
export function planCopy(map: KeyMap, src: MagneticKeySettings, targets: readonly KeyRef[]): Plan {
  const changes = new Map<string, MagneticKeySettings>();
  for (const t of targets) {
    if (same(t, src)) continue;
    changes.set(keyIdOf(t), settingsForCopy(src, t));
  }
  return withPartnersReleased(map, changes);
}

/** A key's mode as the Actuation tab names it — for anything that reports
 *  one (the profile comparator). English unless given the app's `t`; the
 *  comparator's rows do not carry one yet. */
export function modeLabel(mode: MagneticMode | undefined, t: TFunc = getT('en')): string {
  const c = choiceOf(mode);
  if (c === 'toggle')
    return t(toggleStyleOf(mode) === 'repeat' ? 'act.mode.toggleRepeat' : 'act.mode.toggleHold');
  const def = MODE_DEFS.find((m) => m.value === c);
  return def ? t(def.labelKey) : String(mode);
}
