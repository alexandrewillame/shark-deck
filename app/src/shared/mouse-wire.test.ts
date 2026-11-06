import { describe, expect, it } from 'vitest';
import {
  companion,
  scalarBytes,
  rgbBytes,
  DPI_CODECS,
  hubMacroSlots,
  V8_MACRO_BASE,
  V8_MACRO_STRIDE,
  v8MacroOffset,
  v8ButtonOffset,
  V8_BUTTON_SLOT_ORDER,
  sleepSecToWire,
  sleepWireToSec,
  V8_BLOCK,
  withEnabledDpiStage,
  applicableDpiStages,
  clampActiveDpiStage,
  DPI_LED_SPEED_WIRE,
  dpiLedSpeedToWire,
  dpiLedSpeedFromWire,
} from './mouse-wire';

describe('companion byte (0x55 - Σ)', () => {
  // Real pairs from the capture's SETTING-WRITE MAP (v8-analysis.txt).
  it.each([
    [0x01, 0x54], // poll 1000 Hz
    [0x02, 0x53], // poll 500 Hz / LOD 2 mm
    [0x04, 0x51], // poll 250 Hz
    [0x10, 0x45], // poll 2000 Hz
    [0x40, 0x15], // poll 8000 Hz
    [0x00, 0x55], // any "off"
    [0x5a, 0xfb], // sleep timer max (90)
    [0x0f, 0x46], // debounce high
  ])('companion(0x%s) = 0x%s', (v, expected) => {
    expect(companion(v)).toBe(expected);
    expect(scalarBytes(v)).toEqual([v, expected]);
  });
});

describe('rgbBytes', () => {
  it('pure green — matches the captured DPI stage-1 colour write [00 ff 00 56]', () => {
    expect(rgbBytes(0, 255, 0)).toEqual([0x00, 0xff, 0x00, 0x56]);
  });
  it('pure blue — matches the captured DPI stage-2 colour write [00 00 ff 56]', () => {
    expect(rgbBytes(0, 0, 255)).toEqual([0x00, 0x00, 0xff, 0x56]);
  });
});

describe('PAW3950 DPI records (the V8) — decoded from session-v8-verify.jsonl', () => {
  const c = DPI_CODECS.paw3950;
  it('round-trips every 50 DPI across the range', () => {
    for (const dpi of [50, 400, 800, 1600, 6400, 12800, 20000, 26000, 30000, 30050, 42000]) {
      expect(c.decode(c.encode(dpi))).toBe(dpi);
    }
  });
  // Every vector below is the settled `08 07 00 00 0c 04 …` payload the vendor
  // Hub wrote for that exact DPI (verify capture; 6400 landed on 6350). They
  // must never change: this is the range our own capture verified.
  it.each([
    [400, [0x07, 0x07, 0x00, 0x47]],
    [800, [0x0f, 0x0f, 0x00, 0x37]],
    [1600, [0x1f, 0x1f, 0x00, 0x17]],
    [3200, [0x3f, 0x3f, 0x00, 0xd7]],
    [6350, [0x7e, 0x7e, 0x00, 0x59]],
    [12800, [0xff, 0xff, 0x00, 0x57]],
    [20000, [0x8f, 0x8f, 0x44, 0xf3]],
    [25950, [0x06, 0x06, 0x88, 0xc1]],
  ])('%d DPI -> %j', (dpi, bytes) => {
    expect(c.encode(dpi)).toEqual(bytes);
  });
  it('carries the same rule on above 30000 DPI (inferred)', () => {
    // 42000 / 50 - 1 = 839 = 0x347: lo 0x47, bits 8-9 = 3 -> 0xcc, no doubling bits
    expect(c.encode(42000)).toEqual([0x47, 0x47, 0xcc, 0xfb]);
    expect(c.decode([0x47, 0x47, 0xcc, 0xfb])).toBe(42000);
    // the third-party client's doubled record is not used: its doubling bits
    // are ignored, so it reads as half (dpi/100 - 1 = 419 -> 21000)
    expect(c.decode([0xa3, 0xa3, 0x55, 0xba])).toBe(21000);
  });
  it('reads the captured records back', () => {
    expect(c.decode([0x8f, 0x8f, 0x44])).toBe(20000);
    expect(c.decode([0x06, 0x06, 0x88])).toBe(25950);
    expect(c.decode([0xff, 0xff, 0x00])).toBe(12800);
  });
  it('clamps to the 50–42000 DPI range', () => {
    expect(c.decode(c.encode(1))).toBe(50);
    expect(c.decode(c.encode(999999))).toBe(42000);
  });
  it('lives in region A, where the V8 driver has always written it', () => {
    expect(c.offset).toBe(V8_BLOCK.DPI_STAGE_REG);
    expect(c.stride).toBe(V8_BLOCK.DPI_STAGE_REG_STRIDE);
  });
});

describe('PAW3955 DPI records (ported-from-vendor, never on our hardware)', () => {
  const c = DPI_CODECS.paw3955;
  const range = { min: 50, max: 60000 };
  it('stores dpi - 1 in 16 bits, X then Y, up to 42000', () => {
    // 1600 - 1 = 1599 = 0x063f
    const r = c.encode(1600, range);
    expect(r.slice(0, 5)).toEqual([0x3f, 0x06, 0x3f, 0x06, 0x00]);
    expect(r[5]).toBe(companion(0x3f, 0x06, 0x3f, 0x06, 0x00));
  });
  it('halves and flags the value above 42000', () => {
    // 60000 / 2 - 1 = 29999 = 0x752f, doubling bits 0x11
    expect(c.encode(60000, range).slice(0, 5)).toEqual([0x2f, 0x75, 0x2f, 0x75, 0x11]);
  });
  it('round-trips every 50 DPI it is offered', () => {
    for (let dpi = 50; dpi <= 60000; dpi += 50) expect(c.decode(c.encode(dpi, range))).toBe(dpi);
  });
  it('clamps into the model range', () => {
    expect(c.decode(c.encode(70000, { min: 50, max: 52000 }))).toBe(52000);
  });
  it('sits where the V8 layout puts its 16th macro slot, so a PAW3955 mouse gets 15', () => {
    expect(v8MacroOffset(15)).toBe(c.offset);
    expect(hubMacroSlots('paw3955')).toBe(15);
    expect(V8_MACRO_BASE + hubMacroSlots('paw3955') * V8_MACRO_STRIDE).toBeLessThanOrEqual(
      c.offset,
    );
    expect(hubMacroSlots('paw3950')).toBe(16);
    expect(hubMacroSlots(undefined)).toBe(16);
  });
});

describe('button slot mapping', () => {
  it('UI buttons 4 and 5 are swapped on the wire', () => {
    expect(V8_BUTTON_SLOT_ORDER).toEqual([0, 1, 2, 4, 3, 5]);
    expect(v8ButtonOffset(2)).toBe(V8_BLOCK.BUTTON_BASE + 2 * 4); // button 3 -> 0x68
    expect(v8ButtonOffset(3)).toBe(V8_BLOCK.BUTTON_BASE + 4 * 4); // button 4 -> 0x70
    expect(v8ButtonOffset(4)).toBe(V8_BLOCK.BUTTON_BASE + 3 * 4); // button 5 -> 0x6c
    expect(v8ButtonOffset(5)).toBe(V8_BLOCK.BUTTON_BASE + 5 * 4); // button 6 -> 0x74
  });
});

describe('sleep timer wire encoding (1 unit = 10 s)', () => {
  it.each([
    [10, 1],
    [300, 30],
    [900, 90],
  ])('%d s <-> wire %d', (sec, wire) => {
    expect(sleepSecToWire(sec)).toBe(wire);
    expect(sleepWireToSec(wire)).toBe(sec);
  });
  it('clamps to 1..90', () => {
    expect(sleepSecToWire(0)).toBe(1);
    expect(sleepSecToWire(99999)).toBe(90);
  });
});

describe('withEnabledDpiStage', () => {
  const stage = (index: number, enabled: boolean) => ({
    index,
    dpi: 400 * (index + 1),
    color: [0, 0, 0] as [number, number, number],
    enabled,
  });

  it('leaves a set that already has an enabled stage untouched', () => {
    const stages = [stage(0, false), stage(1, true), stage(2, false)];
    expect(withEnabledDpiStage(stages)).toBe(stages);
  });

  it('re-enables the preferred stage when nothing is enabled', () => {
    const stages = [stage(0, false), stage(1, false), stage(2, false)];
    expect(withEnabledDpiStage(stages, 2).map((s) => s.enabled)).toEqual([false, false, true]);
  });

  it('falls back to the first stage for an out-of-range or missing preference', () => {
    const stages = [stage(0, false), stage(1, false)];
    expect(withEnabledDpiStage(stages).map((s) => s.enabled)).toEqual([true, false]);
    expect(withEnabledDpiStage(stages, 9).map((s) => s.enabled)).toEqual([false, true]);
    expect(withEnabledDpiStage(stages, -3).map((s) => s.enabled)).toEqual([true, false]);
    expect(withEnabledDpiStage(stages, NaN).map((s) => s.enabled)).toEqual([true, false]);
  });

  it('does not mutate the input and leaves every other field alone', () => {
    const stages = [stage(0, false), stage(1, false)];
    const out = withEnabledDpiStage(stages);
    expect(stages[0]!.enabled).toBe(false);
    expect(out[0]).toEqual({ ...stages[0], enabled: true });
    expect(out[1]).toBe(stages[1]);
  });

  it('tolerates an empty set', () => {
    expect(withEnabledDpiStage([])).toEqual([]);
  });
});

describe('applicableDpiStages', () => {
  const stage = (index: number, enabled: boolean) => ({
    index,
    dpi: 400 * (index + 1),
    color: [0, 0, 0] as [number, number, number],
    enabled,
  });

  it('drops disabled stages instead of flagging them', () => {
    const out = applicableDpiStages([stage(0, true), stage(1, false), stage(2, true)]);
    expect(out.map((s) => s.dpi)).toEqual([400, 1200]);
    expect(out.every((s) => s.enabled)).toBe(true);
  });

  it('renumbers `index` onto the slots the device will actually read', () => {
    const out = applicableDpiStages([stage(0, false), stage(1, true), stage(2, true)]);
    expect(out.map((s) => s.index)).toEqual([0, 1]);
  });

  it('never returns empty for a non-empty set — a mouse always runs at some DPI', () => {
    expect(applicableDpiStages([stage(0, false), stage(1, false)])).toHaveLength(1);
    expect(applicableDpiStages([stage(0, false), stage(1, false)], 1)[0]!.dpi).toBe(800);
  });

  it('leaves an already-applicable set with the same values and does not mutate the input', () => {
    const stages = [stage(0, true), stage(1, true)];
    expect(applicableDpiStages(stages)).toEqual(stages);
    expect(stages.map((s) => s.enabled)).toEqual([true, true]);
  });

  it('tolerates an empty set', () => {
    expect(applicableDpiStages([])).toEqual([]);
  });
});

describe('clampActiveDpiStage', () => {
  it('passes an in-range index through', () => {
    expect(clampActiveDpiStage(1, 3)).toBe(1);
  });

  it('clamps an index past the last cycled stage — the disabled-stage bug', () => {
    expect(clampActiveDpiStage(1, 1)).toBe(0);
    expect(clampActiveDpiStage(5, 2)).toBe(1);
    expect(clampActiveDpiStage(-2, 3)).toBe(0);
  });

  it('treats an unreadable index as the first stage', () => {
    expect(clampActiveDpiStage(null, 3)).toBe(0);
    expect(clampActiveDpiStage(undefined, 3)).toBe(0);
    expect(clampActiveDpiStage(NaN, 3)).toBe(0);
  });

  it('returns 0 for an empty stage set rather than -1', () => {
    expect(clampActiveDpiStage(2, 0)).toBe(0);
  });
});

/**
 * The DPI-indicator LED breathing speed sits at the INFERRED offset 0x50. The
 * band is 0..4 (the keyboard's LED_MAXSPEED convention); a 2026-09-07 hardware
 * sweep showed the byte accepts and reads back anything 0..5, so the band is a
 * UI-scale choice, not a firmware constraint. What these tests actually
 * protect is that the two converters stay each other's inverse — a codec that
 * does not round-trip shows the user a speed the device is not set to.
 */
describe('DPI-indicator LED speed codec (inferred 0..4 wire band)', () => {
  it('never emits a value outside the observed band', () => {
    for (let ui = -50; ui <= 150; ui += 1) {
      const wire = dpiLedSpeedToWire(ui);
      expect(wire).toBeGreaterThanOrEqual(DPI_LED_SPEED_WIRE.min);
      expect(wire).toBeLessThanOrEqual(DPI_LED_SPEED_WIRE.max);
    }
  });

  it('maps the UI ends and midpoint onto the band ends and midpoint', () => {
    expect(dpiLedSpeedToWire(0)).toBe(0);
    expect(dpiLedSpeedToWire(50)).toBe(2);
    expect(dpiLedSpeedToWire(100)).toBe(4);
  });

  it('round-trips every wire value back to a UI value that re-encodes to it', () => {
    for (let wire = DPI_LED_SPEED_WIRE.min; wire <= DPI_LED_SPEED_WIRE.max; wire++) {
      expect(dpiLedSpeedToWire(dpiLedSpeedFromWire(wire))).toBe(wire);
    }
  });

  it('clamps an out-of-band byte read off the device instead of extrapolating', () => {
    // The hardware sweep accepted 5, and a profile written by some other tool
    // could hold anything at all — none of it may decode past the UI scale.
    expect(dpiLedSpeedFromWire(5)).toBe(100);
    expect(dpiLedSpeedFromWire(255)).toBe(100);
    expect(dpiLedSpeedFromWire(-3)).toBe(0);
  });
});
