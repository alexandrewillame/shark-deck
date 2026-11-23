import type { MacroStep } from './types/macros';
import { normalizeUsage } from './keys';

/**
 * A keyboard macro as the board holds it — shared by the keyboard driver,
 * which writes exactly this (drivers/compx-keyboard.ts `encodeMacro`), and by
 * the macro editor, which counts and matches with it.
 *
 * After a two-byte repeat count, each key event is the HID usage and a byte
 * whose top bit says pressed (1) or released (0) and whose low seven bits are
 * the wait after it, 1-127 ms; 0 there means the wait follows in two more
 * bytes, little-endian, up to 65535 ms. `provenance: verified-capture` — the
 * official software's own macros on an R98 HE (its owner's, 2026-11-22):
 * `04 80 f2 00` is A pressed, then 242 ms; `05 80 32 06` B held 1586 ms;
 * `06 32` C released, then 50 ms. So:
 * - a wait belongs to the key event before it, and waits in a row add up;
 * - a wait before the first event has nowhere to go;
 * - a mouse button or pointer motion has no event (none was ever recorded).
 */
export const KB_MACRO_MAX_WAIT_MS = 0xffff;
/** The longest wait an event carries in its own byte; longer, or none, takes two more. */
export const KB_MACRO_INLINE_WAIT_MS = 0x7f;

export function asKeyboardStores(steps: readonly MacroStep[]): MacroStep[] {
  const out: MacroStep[] = [];
  /** The wait after the last key event, still to be written. */
  let wait = -1;
  const flush = () => {
    if (wait > 0) out.push({ type: 'delay', ms: Math.min(KB_MACRO_MAX_WAIT_MS, wait) });
    wait = -1;
  };
  for (const s of steps) {
    if (s.type === 'delay') {
      if (wait >= 0) wait += Math.max(0, Math.round(s.ms ?? 0));
      continue;
    }
    if (s.type !== 'key') continue;
    flush();
    const value = typeof s.value === 'string' ? normalizeUsage(s.value) : s.value;
    out.push({ type: 'key', action: s.action === 'up' ? 'up' : 'down', value });
    wait = 0;
  }
  flush();
  return out;
}

/** Bytes an event's wait takes beyond the event's own two: none for 1-127 ms, two otherwise. */
export const extraWaitBytes = (ms: number): number =>
  ms >= 1 && ms <= KB_MACRO_INLINE_WAIT_MS ? 0 : 2;

/** The slot a macro read off a keyboard sits in (its `onboard-<slot>` id), or null. */
export const macroSlotOf = (id: string): number | null => {
  const m = /^onboard-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
};
