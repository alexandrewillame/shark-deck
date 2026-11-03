/**
 * Read-only region-A watcher — names the offset behind a setting we have no
 * capture for.
 *
 *   node scripts/watch-region-a.mjs           # region A (0x0000..0x00D7)
 *   node scripts/watch-region-a.mjs --wide    # plus region B (0x0100..0x031F)
 *
 * It polls the V8's per-profile config block and prints only the bytes that
 * change. Open the vendor ATTACK SHARK MOUSE HUB beside it, change ONE
 * setting, and the offset it writes names itself. If nothing at all changes,
 * that is a result too: the setting is not stored in the block being watched,
 * so it goes through a dedicated command instead (as `0x16` does for
 * long-distance mode) — try `--wide`, then reach for the Frida capture.
 *
 * Written for `Mouse Angle Mode`, which is the one sensor control with no
 * captured write behind it. The Hub's own binary has `on_AngleSet_sliderMoved`
 * and `on_AngleSet_valueChanged` slots, so it does write on a drag — the
 * 2026-08-30 capture sweep simply never moved that slider, which is why
 * FINDINGS.md recorded "zero writes" for it. Nothing here is angle-specific
 * though: any unmapped Hub control can be located the same way.
 *
 * Why watching beats sweeping: a byte that accepts a write and reads back is
 * not evidence the firmware acts on it (see FINDINGS.md "Still open" #9 and
 * the 0x50 story). Watching what the vendor tool itself writes has none of
 * that ambiguity.
 *
 * Read-only, and it releases the HID handle between polls so the Hub and
 * SharkDeck can both keep talking to the mouse while it runs.
 */
import HID from 'node-hid';

const VID = 0x3554;
const USAGE_PAGE = 0xff02;
const USAGE = 0x02;
const LEN = 17;
const REGION_A_LEN = 0xd8;
const WIDE = process.argv.includes('--wide');
/** Region B, per docs/reverse-engineering/v8-vendor-block-map.json — 16 fixed
 *  0x20 records the Hub also sweeps on every profile switch. */
const REGION_B = { start: 0x0100, end: 0x0320 };
const POLL_MS = 400;
const CMD = { STATUS: 0x03, READ: 0x08 };

/** Named for the bytes we already know, so an unmapped offset stands out. */
const KNOWN = {
  0x00: 'poll rate',
  0x02: 'DPI stage count',
  0x04: 'active DPI stage',
  0x08: '20K scan',
  0x0a: 'lift-off distance',
  0x4c: 'DPI-LED effect',
  0x4e: 'DPI-LED brightness',
  0x50: 'DPI-LED speed (inferred)',
  0x52: 'DPI-LED flag (inferred)',
  0xa9: 'debounce',
  0xab: 'motion sync',
  0xad: 'sleep timer',
  0xaf: 'angle snapping',
  0xb1: 'ripple control',
  0xb9: 'sensor mode',
};
const label = (off) => {
  if (KNOWN[off]) return KNOWN[off];
  if (KNOWN[off - 1]) return `companion of ${KNOWN[off - 1]}`;
  if (off >= 0x0c && off < 0x2c) return `DPI stage ${Math.floor((off - 0x0c) / 4) + 1} register`;
  if (off >= 0x2c && off < 0x4c) return `DPI stage ${Math.floor((off - 0x2c) / 4) + 1} colour`;
  if (off >= 0x60 && off < 0x78) return `button ${Math.floor((off - 0x60) / 4) + 1}`;
  return 'UNMAPPED';
};

const sharkSum = (b) => (0x55 - b.reduce((s, x) => s + x, 0)) & 0xff;
const hex = (b) => b.toString(16).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(cmd, args = []) {
  const f = new Array(LEN).fill(0);
  f[0] = 0x08;
  f[1] = cmd;
  args.forEach((a, i) => (f[2 + i] = a & 0xff));
  f[LEN - 1] = sharkSum(f.slice(0, LEN - 1));
  return f;
}

async function exchange(dev, query, cmd, accept) {
  await dev.write(query);
  for (let r = 0; r < 8; r++) {
    let raw;
    try {
      raw = await dev.read(200);
    } catch {
      return null;
    }
    if (!raw || raw.length === 0) continue;
    const d = Array.from(raw);
    if (d[1] !== cmd) continue;
    if (d.every((x, i) => x === query[i])) continue; // our own echo
    if (accept && !accept(d)) continue; // a reply for someone else's offset
    return d;
  }
  return null;
}

/** The offsets one pass reads, low to high. */
const spans = () => {
  const out = [];
  for (let off = 0; off < REGION_A_LEN; off += 10)
    out.push([off, Math.min(10, REGION_A_LEN - off)]);
  if (WIDE) {
    for (let off = REGION_B.start; off < REGION_B.end; off += 10) {
      out.push([off, Math.min(10, REGION_B.end - off)]);
    }
  }
  return out;
};

/** One snapshot as an offset -> byte map, or null if the mouse is dozing. */
async function snapshot(dev) {
  const out = new Map();
  for (const [off, n] of spans()) {
    const q = frame(CMD.READ, [0x00, (off >> 8) & 0xff, off & 0xff, n]);
    // Same offset check the driver now makes: the Hub is polling this mouse on
    // its own handle, and Windows copies every input report to both of us.
    const reply = await exchange(
      dev,
      q,
      CMD.READ,
      (d) => ((d[3] << 8) | d[4]) === off && d[5] === n,
    );
    if (!reply) return null;
    for (let i = 0; i < n; i++) out.set(off + i, reply[6 + i]);
  }
  return out;
}

async function withDevice(fn) {
  const found = (await HID.devicesAsync()).filter(
    (d) => d.vendorId === VID && d.usagePage === USAGE_PAGE && d.usage === USAGE,
  );
  if (!found.length) return { ok: false, reason: 'no Attack Shark V8 vendor collection found' };
  // Prefer the cable (F515) when both are present — same mouse, fewer hops.
  const target = found.find((d) => d.productId === 0xf515) ?? found[0];
  let dev;
  try {
    dev = await HID.HIDAsync.open(target.path);
    return { ok: true, value: await fn(dev), pid: target.productId };
  } catch (e) {
    return { ok: false, reason: String(e) };
  } finally {
    try {
      await dev?.close();
    } catch {
      /* the handle is going away either way */
    }
  }
}

console.log('Watching the V8 config block for changes. Ctrl+C to stop.\n');
console.log('  1. leave this running');
console.log('  2. open ATTACK SHARK MOUSE HUB');
console.log('  3. change ONE setting (e.g. drag Mouse Angle Mode)');
console.log('  4. the offset it writes is printed below\n');

let previous = null;
let asleepSince = null;

for (;;) {
  const r = await withDevice(async (dev) => {
    const st = await exchange(dev, frame(CMD.STATUS), CMD.STATUS);
    if (!st || (st[6] ?? 0) === 0) return 'asleep';
    return snapshot(dev);
  });

  if (!r.ok) {
    console.log(`  (${r.reason})`);
    await sleep(2000);
    continue;
  }
  if (r.value === 'asleep' || r.value === null) {
    if (!asleepSince) {
      asleepSince = Date.now();
      console.log('  … mouse is dozing — move it to wake it, then change the setting');
    }
    await sleep(1000);
    continue;
  }
  asleepSince = null;
  const now = r.value;

  if (!previous) {
    console.log(
      `  baseline captured from ${r.pid === 0xf515 ? 'USB-C' : 'the 2.4G dongle'} ` +
        `(${now.size} bytes${WIDE ? ', regions A+B' : ', region A'}). Change a setting now.\n`,
    );
    previous = now;
    continue;
  }

  const changed = [];
  for (const [off, value] of now) if (previous.get(off) !== value) changed.push(off);
  if (changed.length) {
    const stamp = new Date().toLocaleTimeString();
    console.log(`[${stamp}] ${changed.length} byte(s) changed:`);
    for (const off of changed) {
      const from = previous.get(off);
      const to = now.get(off);
      const signed = to > 127 ? to - 256 : to;
      const asSigned = to > 127 ? `  (signed ${signed})` : '';
      console.log(
        `   0x${off.toString(16).padStart(4, '0')}  ${hex(from)} -> ${hex(to)}  ` +
          `(${from} -> ${to})${asSigned}   ${label(off)}`,
      );
    }
    console.log('');
    previous = now;
  }

  await sleep(POLL_MS);
}
