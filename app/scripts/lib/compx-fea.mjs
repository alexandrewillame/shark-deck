/**
 * `compx-fea` framing for the dev scripts, mirroring src/main/hid/frame.ts +
 * checksum.ts so a probe script and the app put bytes in the same places.
 *
 * Frame (65 bytes: leading HID report id + 64-byte vendor payload):
 *
 *   [0]      report id (0x00 for keyboards)
 *   [1]      command
 *   [2..]    args, STEPPING OVER the checksum slot
 *   [k]      checksum = (0xFF - Σ frame[1 .. k-1]) & 0xFF
 *   [k+1..]  bulk payload (NOT summed)
 *
 * k = 8, or 9 for SET_LEDPARAM (0x07) / SET_SLEDPARAM (0x08).
 *
 * This is confirmed twice over: verbatim frames from the 2515-frame
 * iot_driver <-> R85HE capture (src/main/hid/checksum.test.ts), and qmk.top's
 * own `___encodeCmd`, which computes `r[7] = 255 - (sum(r[0..6]) & 255)` over
 * the payload — the same byte once the report id is accounted for (Bit7 -> k=8,
 * Bit8 -> k=9).
 */

export const FRAME_LEN = 65;

/** Checksum slot for a command. */
export const ckIndex = (cmd) => (cmd === 0x07 || cmd === 0x08 ? 9 : 8);

/** Build a `compx-fea` frame. Mirrors buildFrame() in src/main/hid/frame.ts. */
export function frame(cmd, args = [], { reportId = 0x00, len = FRAME_LEN } = {}) {
  const k = ckIndex(cmd);
  const f = new Array(len).fill(0);
  f[0] = reportId;
  f[1] = cmd;
  args.forEach((a, i) => {
    const at = 2 + i < k ? 2 + i : 2 + i + 1;
    if (at < len) f[at] = a & 0xff;
  });
  let sum = 0;
  for (let i = 1; i < k; i++) sum = (sum + f[i]) & 0xff;
  f[k] = (0xff - sum) & 0xff;
  return f;
}

export const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

export const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Where a GET reply's data starts. The firmware sometimes leaves our echoed
 * query checksum in byte 2 and sometimes overwrites it — mirrors
 * feaPayloadStart() in compx-keyboard.ts. `provenance: derived`.
 */
export const payloadStart = (reply, cmd) => (reply[2] === ((0xff - cmd) & 0xff) ? 3 : 2);

/**
 * One SetFeature + one GetFeature — the vendor's own pattern.
 *
 * This firmware is fragile: a burst of feature-report transactions wedges the
 * vendor endpoint (Windows error 0x79) until the board is replugged, so callers
 * must pace themselves and stop on the first echo.
 */
export async function query(
  dev,
  cmd,
  args = [],
  { len = FRAME_LEN, settleMs = 30, paceMs = 120 } = {},
) {
  const q = frame(cmd, args, { len });
  const rec = { cmd, query: hex(q) };
  try {
    await dev.sendFeatureReport(q);
  } catch (e) {
    return { ...rec, sendError: String(e?.message ?? e) };
  }
  await sleep(settleMs);
  let d = null;
  try {
    const raw = await dev.getFeatureReport(0x00, len);
    if (raw) d = Array.from(raw);
  } catch (e) {
    return { ...rec, readError: String(e?.message ?? e) };
  }
  await sleep(paceMs);
  return {
    ...rec,
    reply: d ? hex(d) : null,
    bytes: d,
    echo: !!d && eq(d, q),
    matchesCmd: !!d && d[1] === cmd,
  };
}

/** A reply that actually came from the firmware. */
export const answered = (r) => !!r?.matchesCmd && !r.echo;

/**
 * Open the vendor config collection. Matching is by usage page + usage, never
 * by interface path — the path's instance suffix changes with the USB port.
 */
export async function openVendorCollection(
  HID,
  { vid, pid, usagePage = 0xffff, usage = 0x02 } = {},
) {
  const all = await HID.devicesAsync();
  const cols = all.filter(
    (d) =>
      (vid == null || d.vendorId === vid) &&
      (pid == null || d.productId === pid) &&
      d.usagePage === usagePage &&
      d.usage === usage &&
      d.path,
  );
  return cols;
}
