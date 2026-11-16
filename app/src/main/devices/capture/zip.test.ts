import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readZip } from './zip';

/** A zip as Windows makes one: a stored entry, a deflated one, a folder. */
function zipOf(entries: { name: string; data: Uint8Array; deflate: boolean }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (n: number) => [n & 0xff, n >> 8];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24];
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const body = e.deflate ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const method = e.deflate ? 8 : 0;
    const local = Uint8Array.from([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(body.length),
      ...u32(e.data.length),
      ...u16(name.length),
      ...u16(0),
    ]);
    central.push(
      Uint8Array.from([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(method),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(body.length),
        ...u32(e.data.length),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]),
    );
    parts.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const dir = central.reduce((n, c) => n + c.length, 0);
  const end = Uint8Array.from([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(dir),
    ...u32(offset),
    ...u16(0),
  ]);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('opening a recording .zip', () => {
  it('reads stored and deflated entries, skips folders, and mends backslashed names', () => {
    const text = new TextEncoder().encode('report '.repeat(50));
    const zip = zipOf([
      { name: 'report.txt', data: text, deflate: true },
      { name: 'screens/', data: new Uint8Array(), deflate: false },
      {
        name: 'screens\\001-start.open.jpg',
        data: Uint8Array.from([0xff, 0xd8, 0xff]),
        deflate: false,
      },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['report.txt', 'screens/001-start.open.jpg']);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('report '.repeat(50));
    expect([...entries[1]!.data]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('refuses what is not a zip', () => {
    expect(() => readZip(new Uint8Array(100))).toThrow(/not a zip/);
  });
});
