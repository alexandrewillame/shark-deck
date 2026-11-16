/**
 * Reading a protocol off a recording: a series of steps set one setting to
 * known values (DPI 400, 800, 1600...), so the bytes that move between their
 * frames are the setting, and how they move against the values is its
 * encoding. Frames of one shape that all check out under one checksum rule
 * give the checksum. Both are candidates for a person to confirm, not
 * conclusions.
 */
import { hexOf, type HidMessage } from './hidMessages';

export interface SeriesPoint {
  step: string;
  /** The value the step asked for ("800", "#FF0000", "on", "max", "key A"...). */
  value: string;
  /** What the owner typed, which wins when it is a number. */
  note: string;
  messages: HidMessage[];
}

type Expected =
  | { kind: 'number'; n: number }
  | { kind: 'color'; rgb: [number, number, number] }
  | { kind: 'switch'; on: boolean }
  | { kind: 'label'; text: string };

export function expectedOf(value: string, note: string): Expected {
  const fromNote = /(-?\d+(?:\.\d+)?)/.exec(note);
  const v = value.trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    const n = parseInt(v.slice(1), 16);
    return { kind: 'color', rgb: [n >> 16, (n >> 8) & 0xff, n & 0xff] };
  }
  if (/^(on|off)$/i.test(v)) return { kind: 'switch', on: v.toLowerCase() === 'on' };
  if (fromNote) return { kind: 'number', n: Number(fromNote[1]) };
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return { kind: 'number', n: Number(v) };
  return { kind: 'label', text: v || '(no value)' };
}

/** Frames sent to the device, by shape: kind, interface, report id and length. */
function shapes(messages: HidMessage[]): Map<string, HidMessage[]> {
  const out = new Map<string, HidMessage[]>();
  for (const m of messages) {
    if (!m.out || m.kind.startsWith('get-')) continue;
    const key = `${m.kind} if${m.iface} #${m.reportId} ${m.data.length} B`;
    out.set(key, [...(out.get(key) ?? []), m]);
  }
  return out;
}

const int = (x: number) => Number.isInteger(x) && x >= 0 && x <= 0xffff;

/** Ways a number can be written into a frame; each returns null where it does not apply. */
function encodings(values: number[]): { name: string; f: (v: number) => number | null }[] {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const list: { name: string; f: (v: number) => number | null }[] = [];
  for (const k of [1, 2, 4, 5, 10, 20, 40, 50, 100, 200, 400, 1000])
    list.push({
      name: k === 1 ? 'the value itself' : `value × ${k}`,
      f: (v) => (int(v * k) ? v * k : null),
    });
  for (const k of [2, 4, 5, 8, 10, 16, 25, 50, 100])
    list.push({ name: `value ÷ ${k}`, f: (v) => (int(v / k) ? v / k : null) });
  for (const k of [1, 10, 25, 50, 100])
    list.push({ name: `value ÷ ${k} − 1`, f: (v) => (int(v / k - 1) ? v / k - 1 : null) });
  for (const k of [1000, 8000])
    list.push({ name: `${k} ÷ value`, f: (v) => (v && int(k / v) ? k / v : null) });
  const low = sorted[0] ?? 1;
  list.push({
    name: `log2(value ÷ ${low})`,
    f: (v) => (low > 0 && int(Math.log2(v / low)) ? Math.log2(v / low) : null),
  });
  list.push({ name: 'its rank among the values, from 0', f: (v) => sorted.indexOf(v) });
  list.push({ name: 'its rank among the values, from 1', f: (v) => sorted.indexOf(v) + 1 });
  list.push({
    name: 'its rank from the top, from 0',
    f: (v) => sorted.length - 1 - sorted.indexOf(v),
  });
  return list;
}

const readers: { name: string; width: number; read: (d: Uint8Array, at: number) => number }[] = [
  { name: 'byte', width: 1, read: (d, at) => d[at]! },
  { name: 'bytes (little-endian)', width: 2, read: (d, at) => d[at]! | (d[at + 1]! << 8) },
  { name: 'bytes (big-endian)', width: 2, read: (d, at) => (d[at]! << 8) | d[at + 1]! },
];

const PERMUTATIONS: [string, [number, number, number]][] = [
  ['R G B', [0, 1, 2]],
  ['R B G', [0, 2, 1]],
  ['G R B', [1, 0, 2]],
  ['G B R', [1, 2, 0]],
  ['B R G', [2, 0, 1]],
  ['B G R', [2, 1, 0]],
];

/**
 * What a series moved in the frames sent, and the encodings that fit every
 * step of it. `checksums` names, per frame shape, the bytes a checksum rule
 * already explains: shown, marked, and left out of the encoding search.
 */
export function analyzeSeries(
  points: SeriesPoint[],
  checksums = new Map<string, number[]>(),
): string[] {
  const lines: string[] = [];
  const expected = points.map((p) => expectedOf(p.value, p.note));
  const perPoint = points.map((p) => shapes(p.messages));
  const keys = new Set(perPoint.flatMap((s) => [...s.keys()]));
  let found = false;
  for (const key of keys) {
    const present = perPoint
      .map((s, i) => ({ i, frames: s.get(key) ?? [] }))
      .filter((x) => x.frames.length);
    if (present.length < 2) continue;
    // Frames that line up: same count in every step, else the last one of each.
    const counts = new Set(present.map((x) => x.frames.length));
    const columns = counts.size === 1 ? present[0]!.frames.length : 1;
    for (let c = 0; c < columns; c++) {
      const rows = present.map((x) => ({
        i: x.i,
        data: (counts.size === 1 ? x.frames[c] : x.frames[x.frames.length - 1])!.data,
      }));
      const length = rows[0]!.data.length;
      const sum = new Set(checksums.get(key) ?? []);
      const changing: number[] = [];
      for (let at = 0; at < length; at++)
        if (new Set(rows.map((r) => r.data[at])).size > 1) changing.push(at);
      const moving = changing.filter((at) => !sum.has(at));
      if (!moving.length) continue;
      found = true;
      const marked = changing.filter((at) => sum.has(at));
      lines.push(
        `- ${key}${columns > 1 ? `, frame ${c + 1} of ${columns}` : ''}: bytes that change: ${moving.join(', ')}` +
          `${marked.length ? ` (and ${marked.join(', ')}, the checksum)` : ''}`,
      );
      for (const r of rows) {
        const p = points[r.i]!;
        const bytes = changing
          .map(
            (at) => `[${at}]=${r.data[at]!.toString(16).padStart(2, '0')}${sum.has(at) ? '*' : ''}`,
          )
          .join(' ');
        lines.push(
          `  - ${p.value || '(no value)'}${p.note ? ` (note: "${p.note}")` : ''}: ${bytes}`,
        );
      }
      lines.push(
        ...fits(
          rows,
          expected,
          moving.filter((at) => !sum.has(at)),
          length,
          sum,
        ),
      );
    }
  }
  if (!found) lines.push('- No frame sent in these steps differs from one step to the next.');
  return lines;
}

function fits(
  rows: { i: number; data: Uint8Array }[],
  expected: Expected[],
  moving: number[],
  length: number,
  checksum: Set<number>,
): string[] {
  const out: string[] = [];
  const at = (r: { i: number }) => expected[r.i]!;
  const numbers = rows.filter((r) => at(r).kind === 'number');
  if (numbers.length >= 2 && new Set(numbers.map((r) => (at(r) as { n: number }).n)).size >= 2) {
    const values = numbers.map((r) => (at(r) as { n: number }).n);
    const single = new Set<string>();
    for (const reader of readers) {
      for (const p of moving) {
        if (p + reader.width > length || checksum.has(p + reader.width - 1)) continue;
        for (const e of encodings(values)) {
          if (!numbers.every((r) => e.f((at(r) as { n: number }).n) === reader.read(r.data, p)))
            continue;
          // A 16-bit reading whose other byte never moved only restates a byte that fits.
          const low = reader.name.includes('big') ? p + 1 : p;
          if (reader.width === 2 && single.has(`${low}/${e.name}`)) continue;
          if (reader.width === 1) single.add(`${p}/${e.name}`);
          out.push(
            `  - fits: ${reader.name} ${p}${reader.width > 1 ? `–${p + 1}` : ''} = ${e.name}`,
          );
        }
      }
    }
  }
  const colors = rows.filter((r) => at(r).kind === 'color');
  if (colors.length >= 2) {
    for (let p = 0; p + 3 <= length; p++) {
      for (const [name, order] of PERMUTATIONS) {
        const ok = colors.every((r) => {
          const rgb = (at(r) as { rgb: [number, number, number] }).rgb;
          return order.every((o, j) => r.data[p + j] === rgb[o]);
        });
        if (ok && moving.some((m) => m >= p && m < p + 3))
          out.push(`  - fits: colour at bytes ${p}–${p + 2}, in ${name} order`);
      }
    }
  }
  const switches = rows.filter((r) => at(r).kind === 'switch');
  if (switches.length >= 2) {
    for (const p of moving) {
      const on = new Set(
        switches.filter((r) => (at(r) as { on: boolean }).on).map((r) => r.data[p]),
      );
      const off = new Set(
        switches.filter((r) => !(at(r) as { on: boolean }).on).map((r) => r.data[p]),
      );
      if (on.size === 1 && off.size === 1 && [...on][0] !== [...off][0]) {
        const hex = (s: Set<number | undefined>) => [...s][0]!.toString(16).padStart(2, '0');
        out.push(`  - fits: byte ${p}: on = ${hex(on)}, off = ${hex(off)}`);
      }
    }
  }
  return out.length
    ? out.slice(0, 12)
    : ['  - no simple encoding fits every step: read the bytes above'];
}

// ---- Checksums -----------------------------------------------------------------

type Sum8 = { name: string; f: (sum: number, xor: number) => number };
const SUM8: Sum8[] = [
  { name: 'Σ & 0xFF', f: (s) => s & 0xff },
  { name: '(0x100 − Σ) & 0xFF', f: (s) => (0x100 - (s & 0xff)) & 0xff },
  { name: '(0xFF − Σ) & 0xFF', f: (s) => (0xff - s) & 0xff },
  { name: '(0x55 − Σ) & 0xFF', f: (s) => (0x55 - s) & 0xff },
  { name: 'XOR', f: (_s, x) => x },
];

function crc16(
  d: Uint8Array,
  from: number,
  to: number,
  poly: number,
  init: number,
  reflected: boolean,
): number {
  let crc = init;
  for (let i = from; i < to; i++) {
    if (reflected) {
      crc ^= d[i]!;
      for (let b = 0; b < 8; b++) crc = crc & 1 ? (crc >>> 1) ^ poly : crc >>> 1;
    } else {
      crc ^= d[i]! << 8;
      for (let b = 0; b < 8; b++)
        crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

const SUM16: { name: string; f: (d: Uint8Array, from: number, to: number) => number }[] = [
  { name: 'Σ (16-bit)', f: (d, a, b) => d.subarray(a, b).reduce((s, x) => s + x, 0) & 0xffff },
  { name: 'CRC-16/MODBUS', f: (d, a, b) => crc16(d, a, b, 0xa001, 0xffff, true) },
  { name: 'CRC-16/ARC', f: (d, a, b) => crc16(d, a, b, 0xa001, 0, true) },
  { name: 'CRC-16/CCITT-FALSE', f: (d, a, b) => crc16(d, a, b, 0x1021, 0xffff, false) },
  { name: 'CRC-16/XMODEM', f: (d, a, b) => crc16(d, a, b, 0x1021, 0, false) },
];

export interface ChecksumRule {
  /** The checksum's bytes. */
  at: number[];
  text: string;
}

/**
 * Checksum rules the frames of one shape follow: a byte (or two) at a fixed
 * place, computed over the bytes from a fixed start up to it. Needs at least
 * three different frames, and the checksum itself must vary. With ten
 * different frames or more, a rule may leave out a few, which it names: a
 * frame of another kind can share the report (the R85HE's software opens with
 * a bare `fd`, no checksum, on the same report as all its checksummed
 * commands). Only the rules that leave out the fewest frames are kept, and
 * never one summing over an earlier checksum: after a checksum the sum is
 * constant, so each zero of the padding would "fit" as one more.
 */
export function findChecksums(frames: Uint8Array[]): ChecksumRule[] {
  const distinct = [...new Map(frames.map((f) => [hexOf(f, false), f])).values()].slice(0, 300);
  if (distinct.length < 3) return [];
  const length = Math.min(...distinct.map((f) => f.length));
  const spare = distinct.length >= 10 ? Math.max(1, Math.floor(distinct.length / 20)) : 0;
  const candidates: { at: number[]; from: number; text: string; misses: number }[] = [];
  const add = (at: number[], from: number, text: string, misses: Uint8Array[]) => {
    if (misses.length > spare) return;
    const left = misses
      .slice(0, 3)
      .map((f) => `\`${hexOf(f.subarray(0, 8), false)}…\``)
      .join(', ');
    candidates.push({
      at,
      from,
      misses: misses.length,
      text: misses.length
        ? `${text} (all but ${misses.length} of ${distinct.length} different frames: ${left})`
        : text,
    });
  };
  for (let k = 1; k < length; k++) {
    if (new Set(distinct.map((f) => f[k])).size < 2) continue;
    for (let from = 0; from <= 2 && from < k; from++) {
      for (const rule of SUM8) {
        const misses = distinct.filter((f) => {
          let sum = 0;
          let xor = 0;
          for (let i = from; i < k; i++) {
            sum += f[i]!;
            xor ^= f[i]!;
          }
          return rule.f(sum, xor) !== f[k];
        });
        add([k], from, `byte ${k} = ${rule.name} of bytes ${from}–${k - 1}`, misses);
      }
    }
  }
  for (let k = 1; k + 1 < length; k++) {
    if (new Set(distinct.map((f) => f[k]! | (f[k + 1]! << 8))).size < 2) continue;
    for (let from = 0; from <= 2 && from < k; from++) {
      for (const rule of SUM16) {
        add(
          [k, k + 1],
          from,
          `bytes ${k}–${k + 1} = ${rule.name} of bytes ${from}–${k - 1}, little-endian`,
          distinct.filter((f) => rule.f(f, from, k) !== (f[k]! | (f[k + 1]! << 8))),
        );
        add(
          [k, k + 1],
          from,
          `bytes ${k}–${k + 1} = ${rule.name} of bytes ${from}–${k - 1}, big-endian`,
          distinct.filter((f) => rule.f(f, from, k) !== ((f[k]! << 8) | f[k + 1]!)),
        );
      }
    }
  }
  if (!candidates.length) return [];
  const fewest = Math.min(...candidates.map((c) => c.misses));
  const found: ChecksumRule[] = [];
  for (const c of candidates) {
    if (c.misses !== fewest || found.length >= 4) continue;
    if (found.some((r) => r.at.some((b) => b >= c.from && b < c.at[0]!))) continue;
    found.push({ at: c.at, text: c.text });
  }
  return found;
}
