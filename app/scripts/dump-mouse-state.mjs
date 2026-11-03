/**
 * Pre-image dump of the Attack Shark V8's full onboard state, so a capture
 * session that drives the vendor Mouse Hub (which writes real settings to the
 * mouse) is reversible and every GET / block-read reply layout has a known
 * baseline to diff against.
 *
 *   node scripts/dump-mouse-state.mjs [--out <path>]
 *
 * The V8 dongle (3554:F517) speaks 17-byte `0x08` OUTPUT reports on its vendor
 * collection (MI_01 / usage page 0xFF02 / usage 0x02) — WriteFile/ReadFile, not
 * feature reports. Framing (VERIFIED, docs/protocol/README.md):
 *   byte 0 = 0x08 report id, byte 1 = command, bytes 2..15 = args,
 *   byte 16 = checksum = (0x55 - Σ bytes[0..15]) & 0xFF.
 *
 * What it does, all READ-ONLY except the profile switches (which it undoes):
 *   1. Reads the active profile (0x0E) and restores it at the end.
 *   2. Blind-probes command bytes 0x01..0x2F (minus the two known writes,
 *      0x09 write-block and 0x0F set-profile) with a bare zero-arg frame and
 *      records which answer and with what — this is what pins down the
 *      still-unidentified 0x12 / 0x15 / 0x17 / 0x19 / 0x2D commands.
 *   3. For each of the 4 profiles: switches to it (0x0F), then sweeps the
 *      0x08 read-block command over the vendor Hub's OWN address list
 *      (docs/reverse-engineering/v8-vendor-block-map.json, extracted from the
 *      2026-08-13 capture) and assembles the per-profile block contents. This
 *      is the first time any V8 block payload will have been observed — every
 *      reply in the old capture was lost to overlapped I/O.
 *
 * Default output: ../docs/reverse-engineering/v8-preimage.json
 * The command probe alone is also written to v8-direct-probe.json (sibling of
 * r85he-direct-probe.json). Re-run with `--out v8-postimage.json` after the
 * session and diff to prove the mouse came back.
 */
import fs from 'node:fs';
import path from 'node:path';
import HID from 'node-hid';

const VID = 0x3554;
const PID = 0xf517;
const USAGE_PAGE = 0xff02;
const USAGE = 0x02;
const LEN = 17;

// Run from app/ (the npm scripts' cwd), like dump-keyboard-state.mjs — `..` is
// the repo root.
const RE_DIR = path.resolve('../docs/reverse-engineering');

const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(
  outArg > -1 ? process.argv[outArg + 1] : path.join(RE_DIR, 'v8-preimage.json'),
);
// Keep the probe file beside the image and named after it, so a `--out
// v8-postimage.json` run does not clobber the pre-image's v8-direct-probe.json.
const PROBE_OUT =
  outArg > -1
    ? OUT.replace(/\.json$/i, '') + '-direct-probe.json'
    : path.join(RE_DIR, 'v8-direct-probe.json');

const CMD = {
  STATUS: 0x03,
  BATTERY: 0x04,
  READ_BLOCK: 0x08,
  WRITE_BLOCK: 0x09,
  GET_PROFILE: 0x0e,
  SET_PROFILE: 0x0f,
  GET_VERSION: 0x02,
};

/** Commands never blind-probed: they mutate state with a bare zero-arg frame. */
const PROBE_SKIP = new Set([CMD.WRITE_BLOCK, CMD.SET_PROFILE]);
const PROBE_RANGE = { from: 0x01, to: 0x2f };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sharkSum = (b) => (0x55 - b.reduce((s, x) => s + x, 0)) & 0xff;
const hex = (a) => Buffer.from(a).toString('hex');

/** Build a 17-byte 0x08 frame: [08, cmd, ...args, <pad>, checksum]. */
function frame(cmd, args = []) {
  const f = new Array(LEN).fill(0);
  f[0] = 0x08;
  f[1] = cmd;
  args.forEach((a, i) => (f[2 + i] = a & 0xff));
  f[LEN - 1] = sharkSum(f.slice(0, LEN - 1));
  return f;
}

const isZero = (a) => a.every((x) => x === 0);
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Send `q`, then read up to `reads` reports looking for one whose byte 1 is
 * `cmd` and which is neither our own echo nor an all-zero frame. Returns the
 * raw reply array or null.
 */
async function exchange(dev, q, cmd, { reads = 8, settle = 20 } = {}) {
  await dev.write(q);
  await sleep(settle);
  for (let r = 0; r < reads; r++) {
    let raw;
    try {
      raw = await dev.read(200);
    } catch {
      break;
    }
    if (!raw || raw.length === 0) continue;
    const d = Array.from(raw);
    if (d[1] !== cmd) continue; // not our reply — Hub status poll etc.
    if (eq(d, q)) continue; // driver handed our buffer back
    if (isZero(d)) continue;
    return d;
  }
  return null;
}

async function probeCommands(dev) {
  const results = [];
  for (let c = PROBE_RANGE.from; c <= PROBE_RANGE.to; c++) {
    if (PROBE_SKIP.has(c)) {
      results.push({ cmd: c, skipped: 'known write — not probed' });
      continue;
    }
    const q = frame(c);
    const reply = await exchange(dev, q, c, { reads: 6 });
    results.push({
      cmd: c,
      query: hex(q),
      reply: reply ? hex(reply) : null,
      // The vendor frames declare their payload length at byte 5; surface it.
      declaredLen: reply ? reply[5] : null,
      payload: reply ? hex(reply.slice(6, 6 + (reply[5] || 10))) : null,
    });
    await sleep(60);
  }
  return results;
}

/** One 0x08 read-block request. Returns the `len` payload bytes, or null. */
async function readBlock(dev, offset, len) {
  const q = frame(CMD.READ_BLOCK, [0x00, (offset >> 8) & 0xff, offset & 0xff, len]);
  const reply = await exchange(dev, q, CMD.READ_BLOCK, { reads: 8 });
  if (!reply) return null;
  return reply.slice(6, 6 + len);
}

async function getActiveProfile(dev) {
  const reply = await exchange(dev, frame(CMD.GET_PROFILE), CMD.GET_PROFILE, { reads: 8 });
  return reply && reply.length >= 7 ? reply[6] : null;
}

async function setActiveProfile(dev, idx0) {
  await dev.write(frame(CMD.SET_PROFILE, [0x00, 0x00, 0x00, 0x01, idx0]));
  await sleep(150);
}

async function sweepProfile(dev, map) {
  const raw = [];
  for (const { offset, len } of map) {
    const bytes = await readBlock(dev, offset, len);
    raw.push({ offset, len, hex: bytes ? hex(bytes) : null });
    await sleep(35);
  }
  return raw;
}

/** Stitch the region-A reads (0x0000..~0xD8, contiguous-ish) into one buffer. */
function assembleRegionA(raw) {
  const a = raw.filter((r) => r.offset < 0x0100 && r.hex);
  if (!a.length) return null;
  const end = Math.max(...a.map((r) => r.offset + r.len));
  const buf = Buffer.alloc(end, 0);
  const seen = Buffer.alloc(end, 0);
  for (const r of a) {
    const b = Buffer.from(r.hex, 'hex');
    b.copy(buf, r.offset);
    seen.fill(1, r.offset, r.offset + r.len);
  }
  return { length: end, hex: buf.toString('hex'), covered: seen.reduce((s, x) => s + x, 0) };
}

async function main() {
  const mapPath = path.join(RE_DIR, 'v8-vendor-block-map.json');
  const vendorMap = JSON.parse(fs.readFileSync(mapPath, 'utf-8'));
  const readList = vendorMap.reads.map((r) => ({ offset: r.offset, len: r.len }));

  const cols = (await HID.devicesAsync(VID, PID)).filter(
    (d) => d.usagePage === USAGE_PAGE && d.usage === USAGE && d.path,
  );
  if (!cols.length) {
    console.error('V8 vendor collection not found — is the 8K receiver connected?');
    console.error('Close SharkDeck / ATK HUB / the vendor Mouse Hub first (they hold the handle).');
    process.exit(1);
  }
  const col = cols[0];
  console.log(
    `V8  path=${col.path}\n    serial="${col.serialNumber ?? ''}" release=0x${(col.release ?? 0).toString(16)}\n`,
  );
  const dev = await HID.HIDAsync.open(col.path);

  const result = {
    capturedAt: new Date().toISOString(),
    device: {
      vid: VID,
      pid: PID,
      usagePage: USAGE_PAGE,
      usage: USAGE,
      path: col.path,
      serial: col.serialNumber ?? null,
      release: col.release ?? null,
      product: col.product ?? null,
      manufacturer: col.manufacturer ?? null,
    },
    framing: '17-byte 0x08 output reports; checksum byte16 = (0x55 - Σ bytes[0..15]) & 0xFF',
    vendorMapSource: path.basename(mapPath),
    activeProfileAtStart: null,
    liveness: {},
    commandProbe: [],
    profiles: {},
  };

  let startProfile = null;
  try {
    startProfile = await getActiveProfile(dev);
    result.activeProfileAtStart = startProfile;
    console.log(
      `active profile at start: ${startProfile === null ? 'unknown' : startProfile + 1}\n`,
    );

    // Liveness / battery / firmware, for the pre-image record.
    const status = await exchange(dev, frame(CMD.STATUS), CMD.STATUS, { reads: 8 });
    const batt = await exchange(dev, frame(CMD.BATTERY), CMD.BATTERY, { reads: 8 });
    const fwDev = await exchange(
      dev,
      frame(CMD.GET_VERSION, [0x00, 0x00, 0x00, 0x01, 0x01]),
      CMD.GET_VERSION,
      { reads: 8 },
    );
    const fwRx = await exchange(
      dev,
      frame(CMD.GET_VERSION, [0x00, 0x00, 0x00, 0x01, 0x02]),
      CMD.GET_VERSION,
      { reads: 8 },
    );
    result.liveness = {
      status: status ? hex(status) : null,
      battery: batt ? hex(batt) : null,
      firmwareDevice_sel1: fwDev ? hex(fwDev) : null,
      firmwareReceiver_sel2: fwRx ? hex(fwRx) : null,
    };
    console.log(`  status   ${result.liveness.status ?? 'no answer'}`);
    console.log(`  battery  ${result.liveness.battery ?? 'no answer'}`);
    console.log(`  fw sel1  ${result.liveness.firmwareDevice_sel1 ?? 'no answer'}`);
    console.log(`  fw sel2  ${result.liveness.firmwareReceiver_sel2 ?? 'no answer'}\n`);

    console.log(
      `probing commands 0x${PROBE_RANGE.from.toString(16)}..0x${PROBE_RANGE.to.toString(16)} (skipping 0x09, 0x0f) ...`,
    );
    result.commandProbe = await probeCommands(dev);
    const answered = result.commandProbe.filter((r) => r.reply);
    for (const r of answered) console.log(`  0x${r.cmd.toString(16).padStart(2, '0')}  ${r.reply}`);
    console.log(`  ${answered.length} command(s) answered\n`);

    for (let p = 0; p < 4; p++) {
      console.log(`profile ${p + 1}: switching + sweeping ${readList.length} block reads ...`);
      await setActiveProfile(dev, p);
      const confirm = await getActiveProfile(dev);
      const raw = await sweepProfile(dev, readList);
      const gotA = raw.filter((r) => r.offset < 0x100 && r.hex).length;
      const gotB = raw.filter((r) => r.offset >= 0x100 && r.offset < 0x400 && r.hex).length;
      const gotC = raw.filter((r) => r.offset >= 0x400 && r.hex).length;
      console.log(
        `  confirmed active=${confirm === null ? '?' : confirm + 1}  regionA ${gotA}  regionB ${gotB}  regionC ${gotC} answered\n`,
      );
      result.profiles[p + 1] = {
        confirmedActive: confirm,
        regionA: assembleRegionA(raw),
        raw,
      };
    }
  } finally {
    if (startProfile !== null) {
      console.log(`restoring active profile to ${startProfile + 1} ...`);
      await setActiveProfile(dev, startProfile);
      const back = await getActiveProfile(dev);
      result.activeProfileRestoredTo = back;
      console.log(`  now active=${back === null ? '?' : back + 1}`);
    }
    await dev.close();
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  fs.writeFileSync(
    PROBE_OUT,
    JSON.stringify(
      {
        capturedAt: result.capturedAt,
        device: result.device,
        note: 'Bare zero-arg 0x08 frame sent for each command byte 0x01..0x2F (0x09 write-block and 0x0F set-profile excluded). reply=null means the command did not answer within the read budget.',
        liveness: result.liveness,
        commandProbe: result.commandProbe,
      },
      null,
      1,
    ),
  );
  console.log(`\nwrote ${OUT}`);
  console.log(`wrote ${PROBE_OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
