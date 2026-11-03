import type { ProfileField } from '@shared/types/profiles';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { KB_FACTORY_RELEASE_MM, KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import type { MagneticMode } from '@shared/types/keyboard-settings';
import { getT, type TFunc } from '@shared/i18n';
import { modeLabel } from '../tabs/keyboard/magneticModes';

/**
 * Turning two profile snapshots into something a person can read.
 *
 * The first version of the compare popup printed a collection's LENGTH, so
 * four profiles whose actuation differed on twelve keys rendered as
 * "79 · 79 · 79 · 79" — technically a comparison, and completely useless: the
 * numbers are equal, the profiles are not, and nothing said which keys moved.
 *
 * So the unit here is the individual difference, not the field. A field
 * produces a headline (how much differs) plus one row per actual difference,
 * named the way the rest of the app names it — "W · Actuation", not
 * "magnetic[37].actuationMm".
 *
 * Pure and layout-driven, so it is testable without a device and without a
 * DOM: everything it needs about the keyboard comes from the `KeyLayoutEntry`
 * list the device already reports.
 */

export interface DiffRow {
  /**
   * WHAT the row is about — a key name, a button, a DPI stage, or a bare
   * property when the field has no sub-parts.
   *
   * Kept apart from `setting` rather than pre-joined into "W · Actuation": the
   * two are different kinds of thing (an object on the board vs. a property of
   * it) and the table styles them differently, which a single string cannot
   * express.
   */
  label: string;
  /** the property of `label` that differs, when there is one */
  setting?: string;
  a: string;
  b: string;
  /** literal colours, for the swatch the lighting rows show next to the hex */
  aColor?: string;
  bColor?: string;
  /** this side is the factory value, so the other side is the deliberate one */
  aDefault?: boolean;
  bDefault?: boolean;
  /**
   * Which item of a keyed field the row belongs to — `"row,col"` for
   * actuation, the slot or index for the others. A key's rows are contiguous;
   * `blocksByKey` groups them, and the comparator copies one key by it.
   */
  keyId?: string;
}

/** One key's rows of a keyed field, in order. */
export interface KeyBlock {
  keyId: string;
  name: string;
  rows: DiffRow[];
}

/** A keyed field's rows grouped per key (they are contiguous by construction). */
export function blocksByKey(rows: DiffRow[]): KeyBlock[] {
  const out: KeyBlock[] = [];
  for (const r of rows) {
    const id = r.keyId ?? r.label;
    const last = out[out.length - 1];
    if (last && last.keyId === id) last.rows.push(r);
    else out.push({ keyId: id, name: r.label, rows: [r] });
  }
  return out;
}

/**
 * What a `changed`/`total` count is counting, so the caller can pick the right
 * sentence. The sentence itself is NOT built here: "12 of 79 keys differ" is
 * user-facing prose and belongs in the i18n catalogue, while everything else
 * in this module is either a device value or a label the app already shows
 * untranslated.
 */
export type DiffUnit = 'key' | 'setting' | 'button' | 'stage' | 'value';

export interface FieldDiff {
  field: ProfileField;
  same: boolean;
  /** every individual difference; empty for a scalar, which `a`/`b` cover */
  rows: DiffRow[];
  /** neither side could be read */
  unread: boolean;
  unit: DiffUnit;
  /** how many units differ, and out of how many. Both 0 for a scalar. */
  changed: number;
  total: number;
  /**
   * The NAMES of the keys that differ, for `unit: 'key'`.
   *
   * Names rather than wire ids because the three key-addressed fields index
   * differently (row/col, layout index, firmware slot) and cannot be unioned
   * as ids — but "W" is "W" in all of them, so a caller wanting "how many
   * keys differ in total" can union these across fields without double
   * counting a key that differs in both its actuation and its colour.
   */
  changedKeys?: string[];
  /** the two formatted values, for `unit: 'value'` */
  a?: string;
  b?: string;
}

/** Key names, looked up the three ways the wire addresses a key. */
export interface KeyNames {
  bySlot: Map<number, string>;
  byRowCol: Map<string, string>;
  byIndex: Map<number, string>;
}

export function keyNames(layout: KeyLayoutEntry[] | undefined): KeyNames {
  const bySlot = new Map<number, string>();
  const byRowCol = new Map<string, string>();
  const byIndex = new Map<number, string>();
  (layout ?? []).forEach((k, i) => {
    bySlot.set(k.slot ?? i, k.label);
    byRowCol.set(`${k.row},${k.col}`, k.label);
    byIndex.set(i, k.label);
  });
  return { bySlot, byRowCol, byIndex };
}

const MISSING = '—';

/** A scalar, as the app writes it elsewhere. */
function fmt(v: unknown): string {
  if (v === null || v === undefined) return MISSING;
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) {
    return rgbHex(v as [number, number, number]);
  }
  return JSON.stringify(v);
}

const rgbHex = (c: [number, number, number]) =>
  '#' +
  c
    .map((n) =>
      Math.max(0, Math.min(255, n | 0))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

/** Millimetre fields read as measurements, which is how the sliders show them. */
const MM_FIELDS = new Set([
  'actuationMm',
  'releaseMm',
  'rtPressMm',
  'rtReleaseMm',
  'deadZoneMm',
  'deadZoneBottomMm',
  'dksPointMm',
]);

/**
 * Sub-setting names, matching what the Actuation tab's own controls are
 * labelled (SwitchTravelStage.tsx / MagneticSection.tsx use plain English
 * there rather than i18n keys, so these are deliberately the same strings).
 */
const SUB_LABEL: Record<string, string> = {
  actuationMm: 'Actuation',
  releaseMm: 'Release',
  rapidTrigger: 'Rapid Trigger',
  rtPressMm: 'RT press',
  rtReleaseMm: 'RT release',
  deadZoneMm: 'Top dead zone',
  deadZoneBottomMm: 'Bottom dead zone',
  fullBottomOut: 'Full bottom-out',
  mode: 'Mode',
  dksPointMm: 'DKS point',
  mtHoldMs: 'Mod-tap hold',
  socdPartner: 'Snap-tap partner',
};

const sub = (k: string) => SUB_LABEL[k] ?? k;

/**
 * The factory value for a per-key setting, where there is one.
 *
 * Taken from `KB_TRAVEL_RANGE`, which is what the Actuation tab's own sliders
 * reset to — a "(default)" marker that disagreed with the Restore-defaults
 * button would be worse than no marker. Absent means "this setting has no
 * meaningful default", not "its default is zero".
 *
 * The release point has TWO: what Reset writes (linked to the 2.0 mm
 * actuation) and what an untouched board reads (`KB_FACTORY_RELEASE_MM`,
 * 2.8 mm). The Actuation tab's Default group accepts both (`isFactoryDefault`),
 * and a comparator that called a factory-fresh key's release "changed" would
 * disagree with it.
 */
const SUB_DEFAULT: Record<string, number | readonly number[] | boolean | string> = {
  actuationMm: KB_TRAVEL_RANGE.travel.default,
  releaseMm: [KB_TRAVEL_RANGE.travel.default, KB_FACTORY_RELEASE_MM],
  rtPressMm: KB_TRAVEL_RANGE.rt.default,
  rtReleaseMm: KB_TRAVEL_RANGE.rt.default,
  deadZoneMm: KB_TRAVEL_RANGE.deadzone.default,
  deadZoneBottomMm: KB_TRAVEL_RANGE.deadzone.default,
  rapidTrigger: false,
  fullBottomOut: false,
  mode: 'normal',
};

/** Whether a value is the factory one. Floats compare with a tolerance of
 *  under one wire unit (0.005 mm), since travel is stored quantised. */
function isDefault(key: string, v: unknown): boolean {
  const d = SUB_DEFAULT[key];
  if (d === undefined || v === null || v === undefined) return false;
  if (typeof v === 'number') {
    if (typeof d === 'number') return Math.abs(d - v) < 0.005;
    if (Array.isArray(d)) return d.some((x) => Math.abs(x - v) < 0.005);
  }
  return d === v;
}

function fmtSub(key: string, v: unknown, names?: KeyNames, t: TFunc = getT('en')): string {
  if (v === null || v === undefined) return MISSING;
  if (MM_FIELDS.has(key) && typeof v === 'number') return `${v.toFixed(2)} mm`;
  if (key === 'mtHoldMs' && typeof v === 'number') return `${v} ms`;
  // The Actuation tab's own words, not the wire's: "Toggle, held down", not
  // "tgl_hold"; the partner by the key's name, not its matrix row and column.
  if (key === 'mode' && typeof v === 'string') return modeLabel(v as MagneticMode, t);
  if (key === 'socdPartner' && typeof v === 'object') {
    const p = v as { row: number; col: number };
    return names?.byRowCol.get(`${p.row},${p.col}`) ?? `${p.row},${p.col}`;
  }
  return fmt(v);
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every property either side has, so a key present on one only still shows. */
function unionKeys(a: unknown, b: unknown): string[] {
  const ks = new Set<string>();
  for (const o of [a, b]) {
    if (o && typeof o === 'object') for (const k of Object.keys(o)) ks.add(k);
  }
  return [...ks];
}

/**
 * Differing properties of two plain objects.
 *
 * With a `subject` the property becomes the row's `setting` and the subject its
 * `label` ("Button 2" / "action"); without one the property IS the subject, as
 * for a settings block that has no per-item structure.
 */
function objectRows(a: unknown, b: unknown, subject?: string): DiffRow[] {
  const av = (a ?? {}) as Record<string, unknown>;
  const bv = (b ?? {}) as Record<string, unknown>;
  return unionKeys(a, b)
    .filter((k) => !eq(av[k], bv[k]))
    .map((k) => ({
      label: subject ?? k,
      ...(subject ? { setting: k } : {}),
      a: fmt(av[k]),
      b: fmt(bv[k]),
    }));
}

/**
 * Two collections of per-key records, matched on an id rather than on
 * position. Position matching would report every key as changed the moment one
 * profile reported a key the other did not.
 */
function keyedRows<T>(
  a: T[] | Record<string, T> | null | undefined,
  b: T[] | Record<string, T> | null | undefined,
  idOf: (item: T, index: number) => string,
  nameOf: (id: string, item: T) => string,
  rowsFor: (name: string, x: T | undefined, y: T | undefined) => DiffRow[],
): { rows: DiffRow[]; changed: number; total: number; names: string[] } {
  const index = (c: typeof a) => {
    const m = new Map<string, T>();
    if (!c) return m;
    const entries: Array<[string, T]> = Array.isArray(c)
      ? c.map((v, i) => [idOf(v, i), v])
      : Object.entries(c).map(([k, v]) => [k, v]);
    for (const [k, v] of entries) m.set(k, v);
    return m;
  };
  const am = index(a);
  const bm = index(b);
  const ids = [...new Set([...am.keys(), ...bm.keys()])];
  const rows: DiffRow[] = [];
  const names: string[] = [];
  for (const id of ids) {
    const x = am.get(id);
    const y = bm.get(id);
    if (eq(x, y)) continue;
    const name = nameOf(id, (x ?? y)!);
    names.push(name);
    rows.push(...rowsFor(name, x, y).map((r) => ({ ...r, keyId: id })));
  }
  return { rows, changed: names.length, total: ids.length, names };
}

/**
 * One field of two profiles, compared.
 *
 * `a`/`b` are whatever `snapshotProfiles` read for that field — the real
 * setting objects, not summaries, which is what makes a per-key diff possible
 * in the renderer with no extra round trip to the device.
 */
/** `t` puts the Actuation tab's own mode names in the UI language. */
export function diffField(
  field: ProfileField,
  a: unknown,
  b: unknown,
  names: KeyNames,
  t: TFunc = getT('en'),
): FieldDiff {
  const unread = (a ?? null) === null && (b ?? null) === null;
  const base = { field, unread, same: eq(a, b), changed: 0, total: 0 };
  if (base.same || unread) return { ...base, unit: 'value' as const, rows: [] };

  switch (field) {
    // --- one value ------------------------------------------------------
    case 'pollRate':
    case 'debounce':
      return { ...base, unit: 'value', rows: [], a: fmt(a), b: fmt(b) };

    // --- one object -----------------------------------------------------
    case 'power':
    case 'sensor':
    case 'sideLighting': {
      const rows = objectRows(a, b);
      return { ...base, unit: 'setting', changed: rows.length, total: rows.length, rows };
    }
    case 'lighting': {
      // The driver reports a list of zones; only the first is ever edited.
      const rows = objectRows((a as unknown[])?.[0], (b as unknown[])?.[0]);
      return { ...base, unit: 'setting', changed: rows.length, total: rows.length, rows };
    }

    // --- per-key / per-index collections ---------------------------------
    case 'magnetic': {
      const r = keyedRows<Record<string, unknown>>(
        a as never,
        b as never,
        (k) => `${k.row},${k.col}`,
        (id) => names.byRowCol.get(id) ?? id,
        (name, x, y) =>
          unionKeys(x, y)
            .filter((k) => k !== 'row' && k !== 'col' && !eq(x?.[k], y?.[k]))
            .map((k) => ({
              label: name,
              setting: sub(k),
              a: fmtSub(k, x?.[k], names, t),
              b: fmtSub(k, y?.[k], names, t),
              aDefault: isDefault(k, x?.[k]),
              bDefault: isDefault(k, y?.[k]),
            })),
      );
      return {
        ...base,
        unit: 'key',
        changed: r.changed,
        total: r.total,
        rows: r.rows,
        changedKeys: r.names,
      };
    }
    case 'perKeyLighting': {
      const r = keyedRows<{ index: number; color: [number, number, number] }>(
        a as never,
        b as never,
        (c) => String(c.index),
        (id) => names.byIndex.get(Number(id)) ?? `#${id}`,
        (name, x, y) => [
          {
            label: name,
            a: x ? rgbHex(x.color) : MISSING,
            b: y ? rgbHex(y.color) : MISSING,
            aColor: x ? rgbHex(x.color) : undefined,
            bColor: y ? rgbHex(y.color) : undefined,
          },
        ],
      );
      return {
        ...base,
        unit: 'key',
        changed: r.changed,
        total: r.total,
        rows: r.rows,
        changedKeys: r.names,
      };
    }
    case 'keyRemapBase':
    case 'keyRemapFn': {
      const r = keyedRows<{ slot: number; label?: string; code: string | null }>(
        a as never,
        b as never,
        (k) => String(k.slot),
        (id) => names.bySlot.get(Number(id)) ?? `#${id}`,
        (name, x, y) => [{ label: name, a: bindingLabel(x), b: bindingLabel(y) }],
      );
      return {
        ...base,
        unit: 'key',
        changed: r.changed,
        total: r.total,
        rows: r.rows,
        changedKeys: r.names,
      };
    }
    case 'switchTypes': {
      const r = keyedRows<number>(
        a as never,
        b as never,
        (_v, i) => String(i),
        (id) => names.bySlot.get(Number(id)) ?? `#${id}`,
        (name, x, y) => [{ label: name, a: fmt(x), b: fmt(y) }],
      );
      return {
        ...base,
        unit: 'key',
        changed: r.changed,
        total: r.total,
        rows: r.rows,
        changedKeys: r.names,
      };
    }
    case 'buttons': {
      const r = keyedRows<Record<string, unknown>>(
        a as never,
        b as never,
        (_v, i) => String(i),
        (id) => `Button ${Number(id) + 1}`,
        (name, x, y) => objectRows(x, y, name),
      );
      return { ...base, unit: 'button', changed: r.changed, total: r.total, rows: r.rows };
    }
    case 'dpiStages': {
      const r = keyedRows<Record<string, unknown>>(
        a as never,
        b as never,
        (_v, i) => String(i),
        (id) => `Stage ${Number(id) + 1}`,
        (name, x, y) => objectRows(x, y, name),
      );
      return { ...base, unit: 'stage', changed: r.changed, total: r.total, rows: r.rows };
    }
    default:
      return { ...base, unit: 'value', rows: [], a: fmt(a), b: fmt(b) };
  }
}

function bindingLabel(k: { label?: string; code?: string | null } | undefined): string {
  if (!k) return MISSING;
  return k.label ?? (k.code ? `0x${k.code}` : MISSING);
}
