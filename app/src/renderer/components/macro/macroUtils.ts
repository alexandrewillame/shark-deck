import type { MacroLimits } from '@shared/types/live';
import type { Macro, MacroStep } from '@shared/types/macros';
import type { MessageKey } from '@shared/i18n';
import { normalizeUsage } from '@shared/keys';

/**
 * The editor works on `MacroGroup[]`, not on the raw `MacroStep[]` the wire
 * format and the library file use.
 *
 * A recorded take is a flat run of `down / delay / up / delay / down / …`
 * steps, which as one row per step is close to unreadable — twenty keystrokes
 * render as forty rows. Grouping pairs an adjacent down/up of the same target
 * into a single `tap` carrying its hold time, and folds a run of consecutive
 * delays into one `wait`.
 *
 * A pause is its own row, not a field on the row it precedes. The field form
 * was denser but never said whether the pause happened before or after the
 * thing it sat on, and left no way to hold a pause on its own; as a row, the
 * timeline reads literally top to bottom and a wait drags, duplicates and
 * deletes like anything else. The one pause that stays folded is the one
 * *inside* a tap — the gap between its own down and up — which is the tap's
 * `holdMs`, since that is not a gap between steps at all.
 *
 * Editing against groups also avoids index surgery on the flat array: reorder,
 * duplicate and delete all operate on whole groups and the list is flattened
 * back on save. `toGroups` / `fromGroups` round-trip any step list, including
 * overlapping holds (`down A, down B, up A, up B` stays four separate groups)
 * and the `move` steps older saved macros may still contain.
 */
export type GroupKind = 'tap' | 'press' | 'release' | 'wait' | 'move';

export interface MacroGroup {
  /** stable key for React across reorders — not persisted */
  uid: string;
  kind: GroupKind;
  type: 'key' | 'mouse' | 'wait' | 'move';
  /** HID usage hex string for a key, button bitmask for a mouse button */
  value?: number | string;
  /** `wait` only — how long the macro pauses here, in ms */
  ms?: number;
  /** how long a `tap` holds the target down, in ms */
  holdMs: number;
  /** `move` only — kept so loading a legacy macro never silently loses data */
  dx?: number;
  dy?: number;
}

let uidSeq = 0;
export const newUid = (): string => `g${++uidSeq}`;

/** A fresh pause row. */
export const waitGroup = (ms: number): MacroGroup => ({
  uid: newUid(),
  kind: 'wait',
  type: 'wait',
  ms: Math.max(0, Math.round(ms)),
  holdMs: 0,
});

/** A fresh press-and-release row for a key usage or a mouse button bitmask. */
export const tapGroup = (type: 'key' | 'mouse', value: number | string): MacroGroup => ({
  uid: newUid(),
  kind: 'tap',
  type,
  value,
  holdMs: 0,
});

const isEvent = (s: MacroStep): boolean => s.type === 'key' || s.type === 'mouse';

/**
 * Key usages enter the editor from three places that spell them differently:
 * the recorder and the key table use "4", while both codecs decode to "04".
 * Canonicalising on load is what lets one `<Select>` of ALL_KEYS match a macro
 * read back off the device instead of falling through to a raw hex label.
 */
const canonicalValue = (s: MacroStep): number | string | undefined =>
  s.type === 'key' && typeof s.value === 'string' ? normalizeUsage(s.value) : s.value;

export function toGroups(steps: MacroStep[]): MacroGroup[] {
  const out: MacroGroup[] = [];
  // Consecutive delays collapse into one row rather than stacking two pauses
  // between the same pair of keys.
  let wait = 0;
  const flushWait = () => {
    if (wait > 0) out.push(waitGroup(wait));
    wait = 0;
  };
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.type === 'delay') {
      wait += Math.max(0, s.ms ?? 0);
      continue;
    }
    flushWait();
    if (s.type === 'move') {
      out.push({
        uid: newUid(),
        kind: 'move',
        type: 'move',
        dx: s.dx ?? 0,
        dy: s.dy ?? 0,
        holdMs: 0,
      });
      continue;
    }
    // Look ahead for the matching release, allowing one delay in between
    // (which becomes the hold time). Anything else and this stays a bare
    // press — an overlapping hold must not be collapsed into a tap.
    let hold = 0;
    let upAt = -1;
    if (s.action === 'down') {
      const n1 = steps[i + 1];
      const n2 = steps[i + 2];
      if (
        n1 &&
        isEvent(n1) &&
        n1.type === s.type &&
        n1.action === 'up' &&
        canonicalValue(n1) === canonicalValue(s)
      ) {
        upAt = i + 1;
      } else if (
        n1?.type === 'delay' &&
        n2 &&
        isEvent(n2) &&
        n2.type === s.type &&
        n2.action === 'up' &&
        canonicalValue(n2) === canonicalValue(s)
      ) {
        hold = Math.max(0, n1.ms ?? 0);
        upAt = i + 2;
      }
    }
    out.push({
      uid: newUid(),
      kind: upAt !== -1 ? 'tap' : s.action === 'up' ? 'release' : 'press',
      type: s.type,
      value: canonicalValue(s),
      holdMs: hold,
    });
    if (upAt !== -1) i = upAt;
  }
  // A pause the macro ends on is a real instruction (it spaces out repeats),
  // so it survives as a trailing row instead of being dropped on load.
  flushWait();
  return out;
}

export function fromGroups(groups: MacroGroup[]): MacroStep[] {
  const out: MacroStep[] = [];
  for (const g of groups) {
    if (g.kind === 'wait') {
      const ms = Math.round(g.ms ?? 0);
      // A 0 ms pause is not worth a step record on a device that charges for
      // one; the row can sit in the editor, it just encodes to nothing.
      if (ms > 0) out.push({ type: 'delay', ms });
      continue;
    }
    if (g.kind === 'move') {
      out.push({ type: 'move', dx: g.dx ?? 0, dy: g.dy ?? 0 });
      continue;
    }
    const type = g.type === 'key' || g.type === 'mouse' ? g.type : 'key';
    if (g.kind === 'tap') {
      out.push({ type, action: 'down', value: g.value });
      if (g.holdMs > 0) out.push({ type: 'delay', ms: Math.round(g.holdMs) });
      out.push({ type, action: 'up', value: g.value });
    } else {
      out.push({ type, action: g.kind === 'release' ? 'up' : 'down', value: g.value });
    }
  }
  return out;
}

/**
 * Step records this group list costs in one onboard slot — the number the
 * capacity meter shows. The two codecs differ: the keyboard writes a delay as
 * its own 4-byte record, while the V8 folds a delay into the following step's
 * record, so an identical macro is cheaper there.
 */
export function encodedStepCount(groups: MacroGroup[], limits: MacroLimits | undefined): number {
  let events = 0;
  let delays = 0;
  for (const g of groups) {
    if (g.kind === 'move') continue; // unrepresentable — dropped by both codecs
    if (g.kind === 'wait') {
      if ((g.ms ?? 0) > 0) delays++;
      continue;
    }
    events += g.kind === 'tap' ? 2 : 1;
    if (g.kind === 'tap' && g.holdMs > 0) delays++;
  }
  return limits?.delaysConsumeSteps === false ? events : events + delays;
}

/** Wall-clock length of the macro in ms, for the "≈1.4 s" summary. */
export function groupsDuration(groups: MacroGroup[]): number {
  return groups.reduce(
    (ms, g) => ms + (g.kind === 'wait' ? (g.ms ?? 0) : g.kind === 'tap' ? g.holdMs : 0),
    0,
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Mouse buttons a macro step can target — value is the wire byte itself. */
export const MOUSE_BUTTONS: { value: number; labelKey: MessageKey }[] = [
  { value: 1, labelKey: 'macro.mouse.left' },
  { value: 2, labelKey: 'macro.mouse.right' },
  { value: 4, labelKey: 'macro.mouse.middle' },
  { value: 8, labelKey: 'macro.mouse.back' },
  { value: 16, labelKey: 'macro.mouse.forward' },
];

/** DOM `MouseEvent.button` -> the bitmask above. */
export const DOM_BUTTON_VALUE: Record<number, number> = { 0: 1, 1: 4, 2: 2, 3: 8, 4: 16 };

export const hasUnsupportedSteps = (groups: MacroGroup[]): boolean =>
  groups.some((g) => g.kind === 'move');

/**
 * Round-trip a step list through the group model, which is what normalises a
 * usage spelling and collapses redundant delays. Idempotent.
 */
export const canonicalSteps = (steps: MacroStep[]): MacroStep[] => fromGroups(toGroups(steps));

/**
 * Field-by-field compare against the saved macro, for the dirty indicator.
 *
 * Steps are compared in canonical form on both sides: a macro read off a device
 * spells its usages zero-padded, so comparing raw would mark a macro dirty the
 * instant it was opened, purely because loading it rewrote "04" as "4".
 */
export function macroEquals(
  a: Pick<Macro, 'name' | 'repeatCount' | 'steps'>,
  b: Pick<Macro, 'name' | 'repeatCount' | 'steps'>,
): boolean {
  return (
    a.name === b.name &&
    a.repeatCount === b.repeatCount &&
    JSON.stringify(canonicalSteps(a.steps)) === JSON.stringify(canonicalSteps(b.steps))
  );
}
