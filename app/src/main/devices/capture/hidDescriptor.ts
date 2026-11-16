/**
 * HID report descriptors, read just far enough to say which reports an
 * interface has: their ids, directions, sizes, and the collection they belong
 * to (a keyboard, a mouse, a vendor's settings page).
 */

export type ReportType = 'input' | 'output' | 'feature';

export interface HidReport {
  type: ReportType;
  /** 0 when the interface does not number its reports. */
  id: number;
  /** Payload size, without the id byte. */
  bytes: number;
  /** The top-level collection it belongs to. */
  usagePage: number;
  usage: number;
}

export interface HidDescriptorInfo {
  /** Top-level collections, as usage page / usage. */
  collections: { usagePage: number; usage: number }[];
  reports: HidReport[];
  /** Every report starts with its id byte. */
  numbered: boolean;
}

const MAIN: Record<number, ReportType> = { 0x8: 'input', 0x9: 'output', 0xb: 'feature' };

export function parseReportDescriptor(d: Uint8Array): HidDescriptorInfo {
  const collections: { usagePage: number; usage: number }[] = [];
  const bits = new Map<
    string,
    { type: ReportType; id: number; bits: number; page: number; usage: number }
  >();
  let usagePage = 0;
  let reportSize = 0;
  let reportCount = 0;
  let reportId = 0;
  let usages: number[] = [];
  const stack: { usagePage: number; reportSize: number; reportCount: number; reportId: number }[] =
    [];
  let depth = 0;
  let top = { usagePage: 0, usage: 0 };

  for (let i = 0; i < d.length;) {
    const prefix = d[i]!;
    if (prefix === 0xfe) {
      // Long item: never used by keyboards and mice, skipped whole.
      const size = d[i + 1] ?? 0;
      i += 3 + size;
      continue;
    }
    const size = [0, 1, 2, 4][prefix & 3]!;
    const type = (prefix >> 2) & 3;
    const tag = prefix >> 4;
    let value = 0;
    for (let b = 0; b < size; b++) value |= (d[i + 1 + b] ?? 0) << (8 * b);
    value >>>= 0;
    i += 1 + size;

    if (type === 0) {
      if (tag === 0xa) {
        // Collection
        if (depth === 0) {
          const u = usages[0] ?? 0;
          top = u > 0xffff ? { usagePage: u >>> 16, usage: u & 0xffff } : { usagePage, usage: u };
          collections.push(top);
        }
        depth++;
      } else if (tag === 0xc) {
        depth = Math.max(0, depth - 1);
      } else if (MAIN[tag]) {
        const kind = MAIN[tag]!;
        const key = `${kind}/${reportId}`;
        const entry = bits.get(key) ?? {
          type: kind,
          id: reportId,
          bits: 0,
          page: top.usagePage,
          usage: top.usage,
        };
        entry.bits += reportSize * reportCount;
        bits.set(key, entry);
      }
      usages = [];
    } else if (type === 1) {
      if (tag === 0x0) usagePage = value;
      else if (tag === 0x7) reportSize = value;
      else if (tag === 0x8) reportId = value;
      else if (tag === 0x9) reportCount = value;
      else if (tag === 0xa) stack.push({ usagePage, reportSize, reportCount, reportId });
      else if (tag === 0xb) {
        const s = stack.pop();
        if (s) ({ usagePage, reportSize, reportCount, reportId } = s);
      }
    } else if (type === 2 && (tag === 0x0 || tag === 0x1)) {
      // Usage, or Usage Minimum. A 4-byte usage carries its own page.
      usages.push(value);
    }
  }
  const reports = [...bits.values()].map((b) => ({
    type: b.type,
    id: b.id,
    bytes: Math.ceil(b.bits / 8),
    usagePage: b.page,
    usage: b.usage,
  }));
  return { collections, reports, numbered: reports.some((r) => r.id !== 0) };
}

/** A collection, in words. */
export function usageName(page: number, usage: number): string {
  if (page === 1 && usage === 2) return 'mouse';
  if (page === 1 && usage === 6) return 'keyboard';
  if (page === 1 && usage === 0x80) return 'system controls';
  if (page === 0x0c) return 'media keys';
  if (page >= 0xff00) return 'vendor (settings)';
  return `page ${page.toString(16)} usage ${usage.toString(16)}`;
}
