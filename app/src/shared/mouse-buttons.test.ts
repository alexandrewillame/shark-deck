import { describe, expect, it } from 'vitest';
import { encodeButtonRegionA, actionKeyFromWire, actionWireByte } from './mouse-buttons';
import { companion } from './mouse-wire';

describe('button region-A encoding — vs the captured 0x07 writes', () => {
  // From session-v8-verify.jsonl (v8-verify-analysis.txt SETTING-WRITE MAP).
  it('DPI Switch / DPI loop -> 02 01 00', () => {
    const [a, p1, p2] = encodeButtonRegionA({
      actionKey: 'dpiSwitch',
      action: 0x02,
      param: 0x0100,
    });
    expect([a, p1, p2]).toEqual([0x02, 0x01, 0x00]);
    expect(companion(a, p1, p2)).toBe(0x52); // captured `02 01 00 52`
  });
  it('Polling-rate switch -> 07 00 00', () => {
    expect(encodeButtonRegionA({ actionKey: 'pollRateSwitch', action: 0x07 })).toEqual([
      0x07, 0x00, 0x00,
    ]);
  });
  it('Button / Forward -> 01 10 00 (param high byte)', () => {
    expect(encodeButtonRegionA({ actionKey: 'button', action: 0x01, param: 0x1000 })).toEqual([
      0x01, 0x10, 0x00,
    ]);
  });
  it('DPI Lock -> 0a 0f 00 (vendor constant param)', () => {
    const [a, p1, p2] = encodeButtonRegionA({ actionKey: 'dpiLock', action: 0x0a });
    expect([a, p1, p2]).toEqual([0x0a, 0x0f, 0x00]);
    expect(companion(a, p1, p2)).toBe(0x3c); // captured `0a 0f 00 3c`
  });
  it('Firepower -> 04 <interval> <times>', () => {
    expect(
      encodeButtonRegionA({
        actionKey: 'firepower',
        action: 0x04,
        fire: { interval: 0x0a, times: 3 },
      }),
    ).toEqual([0x04, 0x0a, 0x03]); // captured `04 0a 03 44`
  });
  it('Macro -> 06 <slot> <repeat>', () => {
    expect(
      encodeButtonRegionA({ actionKey: 'macro', action: 0x06, macroSlot: 5, macroRepeat: 0xfe }),
    ).toEqual([0x06, 0x05, 0xfe]); // captured `06 05 fe 4c`
  });
  it('Disable -> 00 00 00', () => {
    expect(encodeButtonRegionA({ actionKey: 'disable', action: 0x00 })).toEqual([0x00, 0x00, 0x00]);
  });
});

describe('action <-> wire byte', () => {
  it('round-trips the confirmed actions', () => {
    for (const key of [
      'button',
      'dpiSwitch',
      'scrollLR',
      'firepower',
      'combo',
      'macro',
      'pollRateSwitch',
      'dpiLock',
      'disable',
    ]) {
      expect(actionKeyFromWire(actionWireByte(key))).toBe(key);
    }
  });
});
