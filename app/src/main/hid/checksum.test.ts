import { describe, expect, it } from 'vitest';
import { appendChecksum, verifyChecksum } from './checksum';
import { buildFrame } from './frame';

/**
 * Real V8 frames captured from the vendor Hub. Profile switches + status/battery
 * polls are from the 2026-08-13 session; the 0x07 write-setting, 0x08 block
 * read, 0x09 restore-defaults, 0x16 long-range and 0x2c receiver-LED frames are
 * from the 2026-08-30 full-feature capture (docs/reverse-engineering/
 * session-v8.jsonl, see FINDINGS.md).
 */
const VERIFIED_SHARK_SUM: Array<[hex: string, cksum: number]> = [
  ['08 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00', 0x4a],
  ['08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00', 0x49],
  ['08 0f 00 00 00 01 00 00 00 00 00 00 00 00 00 00', 0x3d],
  ['08 0f 00 00 00 01 01 00 00 00 00 00 00 00 00 00', 0x3c],
  ['08 0f 00 00 00 01 02 00 00 00 00 00 00 00 00 00', 0x3b],
  ['08 0f 00 00 00 01 03 00 00 00 00 00 00 00 00 00', 0x3a],
  // 0x07 write-setting: button 3 -> DPI-switch, then DPI-+ (companion byte
  // 0x55-0x02-0x01=0x52 / 0x55-0x02-0x02=0x51 inside the payload)
  ['08 07 00 00 68 04 02 01 00 52 00 00 00 00 00 00', 0x85],
  ['08 07 00 00 68 04 02 02 00 51 00 00 00 00 00 00', 0x85],
  ['08 07 00 00 70 04 07 00 00 4e 00 00 00 00 00 00', 0x7d],
  // 0x08 block read requests (offset big-endian, len <= 10)
  ['08 08 00 00 00 0a 00 00 00 00 00 00 00 00 00 00', 0x3b],
  ['08 08 00 00 0a 0a 00 00 00 00 00 00 00 00 00 00', 0x31],
  // 0x09 restore factory defaults
  ['08 09 00 00 00 00 00 00 00 00 00 00 00 00 00 00', 0x44],
  // 0x16 long-distance mode on / off
  ['08 16 00 00 00 0a 01 00 00 00 00 00 00 00 00 00', 0x2c],
  ['08 16 00 00 00 0a 00 00 00 00 00 00 00 00 00 00', 0x2d],
  // 0x2c receiver LED indication (LED 1: off / battery / conn-quality)
  ['08 2c 00 00 00 0a 00 00 02 00 00 00 00 00 00 00', 0x15],
  ['08 2c 00 00 00 0a 02 00 02 00 00 00 00 00 00 00', 0x13],
  ['08 2c 00 00 00 0a 01 00 02 00 00 00 00 00 00 00', 0x14],
  // region-A 0x07 writes, verbatim from the 2026-08-30 full-feature capture
  // (docs/reverse-engineering/session-v8.jsonl). Each pins the frame builder
  // AND the companion arithmetic inside the payload.
  ['08 07 00 00 6c 04 04 0a 03 44 00 00 00 00 00 00', 0x81], // button 5 -> firepower (interval 10, times 3)
  ['08 07 00 00 74 04 06 05 fe 4c 00 00 00 00 00 00', 0x79], // button 6 -> macro (slot 5, repeat 0xfe)
  ['08 07 00 00 ad 02 5a fb 00 00 00 00 00 00 00 00', 0x42], // sleep timer max (0x5a = 90 = 900 s)
  ['08 07 00 00 4e 02 ff 56 00 00 00 00 00 00 00 00', 0xa1], // DPI-LED brightness 0xff
  ['08 07 00 00 0c 04 10 10 00 35 00 00 00 00 00 00', 0xe1], // DPI stage 1 register (800 DPI)
  // 0x05 enter pairing / 0x06 read pair status
  ['08 05 00 00 00 02 00 00 7c 00 00 00 00 00 00 00', 0xca],
  ['08 06 00 00 00 00 00 00 00 00 00 00 00 00 00 00', 0x47],
];

describe('shark-sum checksum (verified against real V8 traffic)', () => {
  for (const [hex, expected] of VERIFIED_SHARK_SUM) {
    it(`${hex} -> 0x${expected.toString(16)}`, () => {
      const body = hex.split(' ').map((h) => parseInt(h, 16));
      const frame = new Uint8Array([...body, 0]);
      const out = appendChecksum(frame, 'shark-sum');
      expect(out[out.length - 1]).toBe(expected);
    });
  }
});

/**
 * compx-fea: `frame[k] = (0xFF - Σ(bytes[1 .. k-1])) & 0xFF`; k = 8, or 9 for
 * SET_LEDPARAM (0x07) / SET_SLEDPARAM (0x08). Bulk payload after k is NOT
 * summed. Every vector below is a real frame from the 2515-frame
 * iot_driver <-> R85HE capture (session-r85he.jsonl), verbatim.
 */
const VERIFIED_COMPX_FEA: Array<[label: string, cmd: number, args: number[], hexStart: string]> = [
  ['SET_REPORT 125 Hz', 0x03, [0x00, 0x06], '00 03 00 06 00 00 00 00 f6'],
  ['SET_REPORT 8000 Hz', 0x03, [0x00, 0x00], '00 03 00 00 00 00 00 00 fc'],
  ['SET_PROFILE slot 4', 0x04, [0x03], '00 04 03 00 00 00 00 00 f8'],
  [
    'per-key travel ESC',
    0x65,
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00],
    '00 65 00 00 00 00 00 00 9a 64 00',
  ],
  [
    'per-key travel Right',
    0x65,
    [0x00, 0x00, 0x59, 0x00, 0x00, 0x00, 0x54, 0x02],
    '00 65 00 00 59 00 00 00 41 54 02',
  ],
  [
    'remap RCtrl->F12',
    0x0a,
    [0x03, 0x47, 0x00, 0x00, 0x01, 0x00, 0x00, 0x45],
    '00 0a 03 47 00 00 01 00 aa 00 45',
  ],
  [
    'SET_LEDPARAM',
    0x07,
    [0x04, 0x02, 0x04, 0x08, 0xfa, 0xff, 0xfa],
    '00 07 04 02 04 08 fa ff fa f3',
  ],
  [
    'SET_SLEDPARAM',
    0x08,
    [0x05, 0x02, 0x04, 0x08, 0xfa, 0xff, 0xfa],
    '00 08 05 02 04 08 fa ff fa f1',
  ],
];

describe('compx-fea checksum (real frames from the iot_driver <-> R85HE capture)', () => {
  for (const [label, cmd, args, hexStart] of VERIFIED_COMPX_FEA) {
    it(label, () => {
      const f = buildFrame({
        reportId: 0x00,
        command: cmd,
        args,
        reportLength: 65,
        checksum: 'compx-fea',
      });
      const got = Array.from(f.subarray(0, hexStart.split(' ').length), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' ');
      expect(got).toBe(hexStart);
      expect(
        verifyChecksum(
          f,
          cmd === 0x07 || cmd === 0x08 ? 'compx-fea' : 'compx-fea',
          cmd === 0x07 || cmd === 0x08 ? 9 : 8,
        ),
      ).toBe(true);
    });
  }
});
