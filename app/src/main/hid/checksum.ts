import type { ChecksumScheme } from '@shared/types/device';

/**
 * Trailing-byte checksum schemes seen across Attack Shark / Compx firmware.
 *
 * `shark-sum` is VERIFIED against real V8 traffic (capture/session.jsonl and
 * capture/FINDINGS.md): the last byte of a 17-byte report is
 * `(0x55 - sum(bytes[0..len-2])) & 0xFF`. Example `08 03 00…00` -> 0x4A.
 *
 * `compx-fea` is the **verified** Attack Shark keyboard scheme, decoded from a
 * 2515-frame capture of `iot_driver_v215.exe` talking to the real R85HE
 * (docs/reverse-engineering/FINDINGS-R85HE.md). Frame:
 *   `[reportId, command, args…, checksum@k, bulk payload…]`
 * `k = 8` for most commands (6 arg slots), `k = 9` for `SET_LEDPARAM` (0x07) /
 * `SET_SLEDPARAM` (0x08) (7 arg slots including RGB). The checksum is
 * `(0xFF - Σ(bytes[1 .. k-1])) & 0xFF` — only the bytes *before* it are summed;
 * the bulk payload after it (magnetism values, RGB map, macro steps) is not.
 * Examples: `00 03 00 06 …00 f6` (03+06+f6=0xFF),
 * `00 07 04 02 04 08 fa ff fa f3` (Σ(07..fa)=0x0C, ck@9=0xF3).
 *
 * `COMPX_FEA_CK_INDEX(command)` gives `k`. `appendChecksum` /
 * `verifyChecksum` take an explicit `ckIndex` for this scheme (buildFrame
 * passes it); default 8.
 *
 * The vendor `CheckSumType.Bit7` enum names this computation; the "Bit7/Bit8"
 * labels in the JS never described the arithmetic. `bit7` / `bit8` below were
 * the pre-capture reconstruction (trailing 7-/8-bit complements) and are kept
 * only so old `provenance: inferred` notes still resolve.
 */

/** checksum byte index for a compx-fea frame with this command */
export function compxFeaCkIndex(command: number): number {
  return command === 0x07 || command === 0x08 ? 9 : 8;
}

/** `(0xFF - Σ(frame[1 .. ck-1])) & 0xFF` */
function compxFeaSum(frame: Uint8Array, ck: number): number {
  let sum = 0;
  for (let i = 1; i < ck; i++) sum = (sum + (frame[i] ?? 0)) & 0xff;
  return (0xff - sum) & 0xff;
}

export function appendChecksum(frame: Uint8Array, scheme: ChecksumScheme, ckIndex = 8): Uint8Array {
  if (scheme === 'none') return frame;

  if (scheme === 'compx-fea') {
    const out = new Uint8Array(frame);
    out[ckIndex] = compxFeaSum(out, ckIndex);
    return out;
  }

  const body = frame.subarray(0, frame.length - 1);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xffff;

  let cksum: number;
  switch (scheme) {
    case 'shark-sum':
      cksum = (0x55 - sum) & 0xff;
      break;
    case 'bit8':
      // running 8-bit additive complement
      cksum = (0x100 - (sum & 0xff)) & 0xff;
      break;
    case 'bit7':
      // 7-bit additive complement, high bit clear
      cksum = (0x80 - (sum & 0x7f)) & 0x7f;
      break;
    default:
      cksum = 0;
  }
  const out = new Uint8Array(frame);
  out[out.length - 1] = cksum;
  return out;
}

export function verifyChecksum(frame: Uint8Array, scheme: ChecksumScheme, ckIndex = 8): boolean {
  if (scheme === 'none') return true;
  if (scheme === 'compx-fea') {
    return frame[ckIndex] === compxFeaSum(frame, ckIndex);
  }
  const expected = appendChecksum(frame, scheme);
  return expected[expected.length - 1] === frame[frame.length - 1];
}
