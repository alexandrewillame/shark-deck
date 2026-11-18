import { describe, expect, it } from 'vitest';
import { buildFrame } from '../../hid/frame';
import { analyzeSeries, expectedOf, findChecksums, type SeriesPoint } from './fields';
import type { HidMessage } from './hidMessages';

const sent = (data: number[] | Uint8Array, reportId = 4): HidMessage => ({
  t: 0,
  done: 0,
  device: '1D57:FA55',
  iface: 1,
  kind: 'set-feature',
  out: true,
  reportId,
  data: Uint8Array.from(data),
  failed: false,
});

const point = (value: string, data: number[], note = ''): SeriesPoint => ({
  step: `step.${value}`,
  value,
  note,
  messages: [sent(data)],
});

describe('reading an encoding off a series of steps', () => {
  it('finds a DPI written as value ÷ 50', () => {
    const lines = analyzeSeries(
      [400, 800, 1600, 3200].map((v) => point(String(v), [0x04, 0x02, 0x00, v / 50, 0, 0])),
    );
    expect(lines.join('\n')).toContain('byte 3 = value ÷ 50');
  });

  it('finds a 16-bit little-endian DPI, and believes the owner’s note over the value asked', () => {
    // "max" with the note "26000": the note is what was really set.
    const points = [
      point('400', [0x04, 0x90, 0x01]),
      point('3200', [0x04, 0x80, 0x0c]),
      point('max', [0x04, 0x90, 0x65], 'it stops at 26000'),
    ];
    expect(analyzeSeries(points).join('\n')).toContain(
      'bytes (little-endian) 1–2 = the value itself',
    );
  });

  it('keeps a rule all but one step follow, and names what the odd step really sent', () => {
    // The X8 PRO recording: "Set DPI stage 1 to 100, or to the lowest value it
    // allows" — the owner set 50 and typed no note, so its bytes say 50.
    const odd = new Map<string, string>();
    const lines = analyzeSeries(
      [
        ...[400, 800, 1600, 3200, 1000, 6400].map((v) =>
          point(String(v), [0x04, 0x01, v / 50 - 1, 0x0f]),
        ),
        point('100', [0x04, 0x01, 0x00, 0x0f]),
      ],
      undefined,
      odd,
    ).join('\n');
    expect(lines).toContain('fits all but 1 step: byte 2 = value ÷ 50 − 1');
    expect(lines).toContain('step.100 asked for 100, its bytes say 50');
    expect([...odd]).toEqual([['step.100', 'its bytes say 50, not 100']]);
  });

  it('does not stretch a rule over a series that is mostly off', () => {
    const lines = analyzeSeries(
      [400, 800, 1600, 3200].map((v, i) =>
        point(String(v), [0x04, 0x01, i < 2 ? v / 50 - 1 : 0x33 + i]),
      ),
    ).join('\n');
    expect(lines).not.toContain('fits all but');
    expect(lines).toContain('no simple encoding fits every step');
  });

  it('finds a polling rate written as an interval, 1000 ÷ value', () => {
    const lines = analyzeSeries(
      [125, 250, 500, 1000].map((v) => point(String(v), [0x06, 0x09, 0x01, 1000 / v])),
    );
    expect(lines.join('\n')).toContain('byte 3 = 1000 ÷ value');
  });

  it('finds a colour and its byte order', () => {
    const lines = analyzeSeries([
      point('#FF0000', [0x05, 0x00, 0xff, 0x00]),
      point('#00FF00', [0x05, 0xff, 0x00, 0x00]),
      point('#0000FF', [0x05, 0x00, 0x00, 0xff]),
    ]);
    expect(lines.join('\n')).toContain('colour at bytes 1–3, in G R B order');
  });

  it('finds a switch', () => {
    const lines = analyzeSeries([point('on', [0x07, 0x01]), point('off', [0x07, 0x00])]);
    expect(lines.join('\n')).toContain('byte 1: on = 01, off = 00');
  });

  it('shows the bytes when no rule fits (a button set to a function)', () => {
    const lines = analyzeSeries([
      point('Middle click', [0x08, 0x01, 0x04]),
      point('key A', [0x08, 0x02, 0x04]),
    ]);
    expect(lines.join('\n')).toMatch(/Middle click: \[1\]=01/);
    expect(lines.join('\n')).toMatch(/key A: \[1\]=02/);
  });

  it('reads values the way an owner writes them', () => {
    expect(expectedOf('#00ff00', '')).toEqual({ kind: 'color', rgb: [0, 255, 0] });
    expect(expectedOf('ON', '')).toEqual({ kind: 'switch', on: true });
    expect(expectedOf('max', '26000 DPI')).toEqual({ kind: 'number', n: 26000 });
    expect(expectedOf('0.5', '')).toEqual({ kind: 'number', n: 0.5 });
    expect(expectedOf('key A', '')).toEqual({ kind: 'label', text: 'key A' });
  });
});

describe('finding a checksum', () => {
  it('finds the V8’s shark-sum on its 17-byte frames', () => {
    const frames = [0x01, 0x03, 0x04, 0x07, 0x09].map((command, i) =>
      buildFrame({
        reportId: 0x08,
        command,
        args: [i, 0x10 * i],
        reportLength: 17,
        checksum: 'shark-sum',
      }),
    );
    expect(findChecksums(frames).map((r) => r.text)).toContain(
      'byte 16 = (0x55 − Σ) & 0xFF of bytes 0–15',
    );
  });

  it('finds the R85HE’s checksum, in the middle of its 65-byte frames', () => {
    const frames = [0x03, 0x05, 0x8f, 0x0a].map((command, i) =>
      buildFrame({
        reportId: 0x00,
        command,
        args: [i, 2 * i + 1],
        reportLength: 65,
        checksum: 'compx-fea',
      }),
    );
    expect(findChecksums(frames).map((r) => r.text)).toContain(
      'byte 8 = (0xFF − Σ) & 0xFF of bytes 1–7',
    );
  });

  it('finds a 16-bit CRC', () => {
    const crc = (d: number[]) => {
      let c = 0xffff;
      for (const b of d) {
        c ^= b;
        for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
      }
      return c;
    };
    const frames = [
      [0x04, 0x11, 0x22],
      [0x04, 0x31, 0x02],
      [0x04, 0x07, 0x99],
    ].map((d) => Uint8Array.from([...d, crc(d) & 0xff, crc(d) >> 8, 0, 0]));
    expect(findChecksums(frames).map((r) => r.text)).toContain(
      'bytes 3–4 = CRC-16/MODBUS of bytes 0–2, little-endian',
    );
  });

  it('finds the R85HE’s checksum past the odd frame out its software sends first', () => {
    // As a recording made in place shows them: 64 bytes without the report id,
    // the checksum at byte 7 with the payload after it, and a bare `fd`
    // (no checksum) on the same report as every checksummed command.
    const command = (b: number[]) => {
      const f = new Uint8Array(64);
      f.set(b.slice(0, 7));
      f[7] = (0xff - b.slice(0, 7).reduce((s, x) => s + x, 0)) & 0xff;
      f.set(b.slice(7), 8);
      return f;
    };
    const frames = [
      Uint8Array.from([0xfd, ...new Array(63).fill(0)]),
      ...[6, 5, 4, 3, 2, 1, 0].map((rate) => command([0x03, 0, rate, 0, 0, 0, 0])),
      command([0x0a, 0, 0x09, 0, 0, 1, 0, 0x00, 0x05]),
      command([0x0a, 0, 0x03, 0, 0, 1, 0, 0x00, 0xe0]),
      command([0x8f, 0, 0, 0, 0, 0, 0]),
      command([0x84, 0, 0, 0, 0, 0, 0]),
    ];
    expect(findChecksums(frames)[0]?.text).toBe(
      'byte 7 = (0xFF − Σ) & 0xFF of bytes 0–6 (all but 1 of 12 different frames: `fd 00 00 00 00 00 00 00…`)',
    );
    // Fewer than ten different frames: every one has to fit.
    expect(findChecksums(frames.slice(0, 6))).toEqual([]);
  });

  it('claims nothing from too few frames', () => {
    expect(findChecksums([Uint8Array.from([1, 2, 3]), Uint8Array.from([1, 2, 3])])).toEqual([]);
  });
});
