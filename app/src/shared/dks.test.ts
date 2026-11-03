import { describe, expect, it } from 'vitest';
import {
  decodeDksZone,
  dksZoneBytes,
  dksZonesFrom,
  encodeDksZone,
  isEmptyDksZone,
  type DksZone,
} from './dks';

/**
 * The DKS zone byte is a small run-length encoding over four trigger points,
 * ported from qmk.top's `ws` / `Lu`. Getting it wrong writes a key that fires
 * at the wrong depth (or not at all), so the round-trip and the rejection rules
 * are both pinned here.
 */

const z = (a: DksZone['a'], b: DksZone['b'], c: DksZone['c'], d: DksZone['d']): DksZone => ({
  a,
  b,
  c,
  d,
});

describe('decodeDksZone', () => {
  it('decodes an empty zone', () => {
    expect(decodeDksZone(0)).toEqual(z(null, null, null, null));
  });

  it.each([
    [0b00_00_00_01, z('A', null, null, null)],
    [0b00_00_01_00, z(null, 'B', null, null)],
    [0b00_01_00_00, z(null, null, 'C', null)],
    [0b01_00_00_00, z(null, null, null, 'D')],
    [0b00_00_00_10, z('A-BS', null, null, null)],
    [0b00_00_10_00, z(null, 'B-CS', null, null)],
    [0b00_10_00_00, z(null, null, 'C-DS', null)],
  ])('decodes 0b%s', (byte, expected) => {
    expect(decodeDksZone(byte)).toEqual(expected);
  });

  it('collapses a span that swallows the points it covers', () => {
    // a=3,b=2 -> A held through C, and B is no longer its own action
    expect(decodeDksZone(0b00_00_10_11)).toEqual(z('A-CS', null, null, null));
    // a=3,b=3,c=2 -> A held all the way to D
    expect(decodeDksZone(0b00_10_11_11)).toEqual(z('A-DS', null, null, null));
    // b=3,c=2 -> B held through D
    expect(decodeDksZone(0b00_10_11_00)).toEqual(z(null, 'B-DS', null, null));
  });

  it('combines independent points', () => {
    expect(decodeDksZone(0b01_01_01_01)).toEqual(z('A', 'B', 'C', 'D'));
  });

  it.each([
    [0b10_00_00_00, 'd > 1'],
    [0b11_00_00_00, 'd > 1'],
    [0b00_11_00_00, 'c > 2'],
    [0b00_00_11_00, 'b === 3 with c < 2'],
    [0b00_00_00_11, 'a === 3 with b < 2'],
  ])('rejects 0b%s (%s)', (byte) => {
    expect(decodeDksZone(byte)).toBeNull();
  });
});

describe('encodeDksZone', () => {
  it('round-trips every byte the firmware would produce', () => {
    let checked = 0;
    for (let byte = 0; byte < 256; byte++) {
      const zone = decodeDksZone(byte);
      if (!zone) continue; // not a shape the firmware emits
      expect(encodeDksZone(zone), `byte ${byte}`).toBe(byte);
      checked++;
    }
    // sanity: the valid space is a real subset, not everything and not nothing
    expect(checked).toBeGreaterThan(20);
    expect(checked).toBeLessThan(256);
  });

  it('encodes an empty zone as 0', () => {
    expect(encodeDksZone(z(null, null, null, null))).toBe(0);
  });
});

describe('dksZoneBytes', () => {
  it('defaults to the vendor default of four zeros', () => {
    expect(dksZoneBytes(undefined)).toEqual([0, 0, 0, 0]);
    expect(dksZoneBytes([])).toEqual([0, 0, 0, 0]);
  });

  it('always returns exactly four bytes', () => {
    expect(dksZoneBytes([z('A', null, null, null)])).toEqual([1, 0, 0, 0]);
    expect(dksZoneBytes([z('A', null, null, null), z(null, 'B', null, null)])).toEqual([
      1, 4, 0, 0,
    ]);
  });

  it('round-trips through dksZonesFrom', () => {
    const zones = [
      z('A', null, null, null),
      z(null, 'B', null, null),
      z('A-DS', null, null, null),
      z(null, null, null, 'D'),
    ];
    expect(dksZonesFrom(dksZoneBytes(zones))).toEqual(zones);
  });
});

describe('isEmptyDksZone', () => {
  it('is true only when nothing happens at any point', () => {
    expect(isEmptyDksZone(z(null, null, null, null))).toBe(true);
    expect(isEmptyDksZone(z('A', null, null, null))).toBe(false);
  });
});
