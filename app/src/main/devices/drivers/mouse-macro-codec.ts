import type { Macro, MacroStep } from '@shared/types/macros';
import {
  companion,
  V8_MACRO_NAME_OFF,
  V8_MACRO_NAME_MAX,
  v8MacroName,
  V8_MACRO_COUNT_OFF,
  V8_MACRO_BODY_OFF,
  V8_MACRO_STEP_BYTES,
  V8_MACRO_STRIDE,
  COMBO_FLAG_DOWN,
  COMBO_FLAG_UP,
  COMBO_PAGE,
} from '@shared/mouse-wire';

/**
 * V8 mouse onboard-macro codec — region C, one 0x180-byte slot per macro.
 *
 * `provenance: verified-capture` for the layout below — re-derived, with the
 * arithmetic checked, against the captured "test" macro (see
 * docs/reverse-engineering/FINDINGS.md). The ENCODE direction is `inferred`:
 * no macro write has been observed on the wire, so a written slot is backed
 * up first and read back after, like every other unconfirmed write.
 *
 * Layout:
 *   +0x00        name length
 *   +0x01..0x1E  ASCII name, 0xFF-padded (30 bytes)
 *   +0x1F        step count
 *   +0x20 +      5-byte step records `[flag, usage, 0x00, delayHi, delayLo]`
 *                (delay is inter-step time in ms, big-endian)
 *   then a companion over `[count .. last record byte]`.
 * flag = COMBO_FLAG_DOWN/UP | COMBO_PAGE (key / media / mouse).
 *
 * `MacroStep.type: 'move'` is not representable — dropped with a warning, same
 * as the keyboard codec. `Macro.repeatCount` has no home in the slot; it rides
 * on the button binding's repeat byte instead.
 */

export const MOUSE_MACRO_MAX_BYTES = V8_MACRO_STRIDE;

const pageOf = (s: MacroStep): number => (s.type === 'mouse' ? COMBO_PAGE.mouse : COMBO_PAGE.key);

const usageOf = (v: MacroStep['value']): number => {
  if (typeof v === 'number') return v & 0xff;
  if (typeof v === 'string') return parseInt(v, 16) & 0xff || 0;
  return 0;
};

/** Encode to the full slot byte array (padded to MOUSE_MACRO_MAX_BYTES). */
export function encodeMouseMacro(m: Macro): number[] {
  // name area is base+0x00 (length) .. base+0x1E; the step count sits at
  // base+0x1F, so the header we build here is exactly V8_MACRO_COUNT_OFF long.
  const buf = new Array<number>(V8_MACRO_COUNT_OFF).fill(0xff);
  // The name as the slot keeps it (v8MacroName): printable ASCII by code
  // point, `?` for anything else — never the low byte of a UTF-16 unit.
  const name = [...v8MacroName(m.name)].map((c) => c.charCodeAt(0));
  buf[0] = name.length;
  name.forEach((c, i) => (buf[V8_MACRO_NAME_OFF + i] = c));

  // Flatten to key/mouse down/up + inter-step delays. A `{type:'delay'}` step
  // folds its ms into the FOLLOWING record's delay field (the vendor stores
  // "time before this step").
  const recs: { flag: number; usage: number; delay: number }[] = [];
  let pendingDelay = 0;
  for (const s of m.steps) {
    if (s.type === 'delay') {
      pendingDelay += Math.max(0, s.ms ?? 0);
      continue;
    }
    if (s.type === 'move') continue; // not representable
    const flag = (s.action === 'up' ? COMBO_FLAG_UP : COMBO_FLAG_DOWN) | pageOf(s);
    recs.push({ flag, usage: usageOf(s.value), delay: Math.min(0xffff, pendingDelay) });
    pendingDelay = 0;
  }

  // Count only the records that actually fit the slot — writing `recs.length`
  // when the loop below truncates left a count byte larger than the steps
  // present, so `decodeMouseMacro` (and the firmware) read the 0xFF fill as
  // phantom key presses with 65535 ms delays.
  const stepBytes: number[] = [];
  let written = 0;
  for (const r of recs) {
    // +1 header count byte, +1 trailing companion byte
    if (V8_MACRO_BODY_OFF + 1 + stepBytes.length + V8_MACRO_STEP_BYTES + 1 > MOUSE_MACRO_MAX_BYTES)
      break;
    stepBytes.push(r.flag & 0xff, r.usage & 0xff, 0x00, (r.delay >> 8) & 0xff, r.delay & 0xff);
    written++;
  }
  const body: number[] = [written & 0xff, ...stepBytes];
  body.push(companion(...body));

  const out = [...buf, ...body];
  while (out.length < MOUSE_MACRO_MAX_BYTES) out.push(0xff);
  return out.slice(0, MOUSE_MACRO_MAX_BYTES);
}

export function decodeMouseMacro(id: string, slotBytes: Uint8Array | number[]): Macro | null {
  const b = Array.from(slotBytes);
  const nameLen = Math.min(b[0] ?? 0, V8_MACRO_NAME_MAX);
  if (nameLen === 0 || nameLen === 0xff) return null;
  const name = b
    .slice(V8_MACRO_NAME_OFF, V8_MACRO_NAME_OFF + nameLen)
    .map((c) => String.fromCharCode(c))
    .join('');

  const count = b[V8_MACRO_COUNT_OFF] ?? 0;
  if (count === 0 || count === 0xff) return null;

  const steps: MacroStep[] = [];
  for (let i = 0; i < count; i++) {
    const off = V8_MACRO_BODY_OFF + i * V8_MACRO_STEP_BYTES;
    if (off + V8_MACRO_STEP_BYTES > b.length) break;
    const flag = b[off]!;
    const usage = b[off + 1]!;
    const delay = ((b[off + 3]! << 8) | b[off + 4]!) & 0xffff;
    const up = (flag & 0xf0) === COMBO_FLAG_UP;
    const isMouse = (flag & 0x0f) === COMBO_PAGE.mouse;
    if (delay > 0) steps.push({ type: 'delay', ms: delay });
    steps.push(
      isMouse
        ? { type: 'mouse', action: up ? 'up' : 'down', value: usage }
        : { type: 'key', action: up ? 'up' : 'down', value: usage.toString(16).padStart(2, '0') },
    );
  }
  if (steps.length === 0) return null;
  return { id, name, repeatCount: 1, steps };
}
