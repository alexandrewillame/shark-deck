import type { ChecksumScheme } from '@shared/types/device';
import { appendChecksum, compxFeaCkIndex } from './checksum';

/** hex string for logs: "08 0f 00 …" */
export function toHex(buf: Uint8Array | number[]): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => parseInt(h, 16)),
  );
}

/**
 * Build a fixed-length report.
 *
 *  - `compx-fea` (Attack Shark keyboards): `[reportId, command, args…,
 *    checksum@k, bulk payload…]` — `k` is 8 for most commands, 9 for
 *    SET_LEDPARAM (0x07) / SET_SLEDPARAM (0x08). `args` are laid out from byte
 *    2; the checksum slot at `k` is stepped over, so anything past 6 (or 7)
 *    args flows in after it as bulk payload. `provenance: verified-capture`
 *    — verified against the 2515-frame iot_driver capture, see
 *    docs/reverse-engineering/FINDINGS-R85HE.md.
 *  - every other scheme: `[reportId, command, ...args, <pad>, checksum]` — the
 *    checksum is the last byte.
 *
 * `reportLength` includes the leading report id.
 */
export function buildFrame(opts: {
  reportId: number;
  command: number;
  args?: ArrayLike<number>;
  reportLength: number;
  checksum: ChecksumScheme;
}): Uint8Array {
  const { reportId, command, args = [], reportLength, checksum } = opts;
  const frame = new Uint8Array(reportLength);
  frame[0] = reportId;
  frame[1] = command;
  if (checksum === 'compx-fea') {
    const ck = compxFeaCkIndex(command);
    for (let i = 0; i < args.length; i++) {
      const at = 2 + i < ck ? 2 + i : 2 + i + 1; // step over the checksum slot
      if (at < reportLength) frame[at] = args[i]!;
    }
    return appendChecksum(frame, checksum, ck);
  }
  for (let i = 0; i < args.length && 2 + i < reportLength - 1; i++) frame[2 + i] = args[i]!;
  return appendChecksum(frame, checksum);
}

/**
 * Parse a reply frame into { command, payload }. `payload` starts at byte 2
 * (the reply's byte 8 is often the stale echoed query checksum, and reply data
 * offsets are per-command — see FINDINGS-R85HE.md). `compx-fea` replies carry
 * no trailing checksum to trim.
 */
export function parseFrame(
  frame: Uint8Array,
  checksum: ChecksumScheme = 'none',
): { command: number; payload: Uint8Array } {
  const end = checksum === 'compx-fea' ? frame.length : frame.length - 1;
  return { command: frame[1] ?? 0, payload: frame.subarray(2, end) };
}
