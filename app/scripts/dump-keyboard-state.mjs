/**
 * Pre-image dump of the R85HE's full onboard state, so a capture session that
 * writes to the board (CAPTURE-KEYBOARD.md) is reversible and its GET_* reply
 * layouts have a known baseline to diff against.
 *
 *   node scripts/dump-keyboard-state.mjs [--out <path>]
 *
 * Sends every GET_* the R85HE's command set (5e635fe2 generation) exposes, as a
 * FEATURE report on the vendor collection (usage page 0xFFFF / usage 0x02),
 * using the VERIFIED `compx-fea` framing: `[00, cmd, checksum, ...args]` with
 * the checksum at byte 2 = `(0xFF - Σ others) & 0xFF`. A reply flagged `echo`
 * is Windows handing back the SetFeature buffer because the firmware did not
 * answer.
 *
 * Writes are PACED (~40 ms apart): dozens of back-to-back HidD_SetFeature calls
 * wedge the MI_02 endpoint (error 0x79) until the keyboard is replugged.
 *
 * Default output: ../docs/reverse-engineering/r85he-preimage.json
 * Re-run after the session and diff to prove the board came back.
 */
import fs from 'node:fs';
import path from 'node:path';
import HID from 'node-hid';

const VID = 0x3151;
const PID = 0x5029;
const USAGE_PAGE = 0xffff;
const USAGE = 0x02;
const LEN = 65; // 64-byte vendor payload + leading report id

const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(
  outArg > -1 ? process.argv[outArg + 1] : '../docs/reverse-engineering/r85he-preimage.json',
);

// 5e635fe2.js GET_* command numbers.
//
// IMPORTANT: this firmware is fragile — a burst of feature-report transactions
// (or a bare GET that actually needs page/layer args) hangs the whole keyboard
// MCU (keys dead, LEDs still on) until a power-cycle, and Driver v4 then can't
// find it either. So this script:
//   * does strictly 1 SetFeature -> 1 GetFeature per command (like the vendor),
//   * waits generously between commands,
//   * STOPS the moment a reply comes back as an echo (firmware not answering —
//     pushing further is what wedges it),
//   * only sends the argument-free GETs. GET_KEYMATRIX/MACRO/USERPIC/FN and the
//     paged GET_MULTI_MAGNETISM need a chunk/layer arg and are left to the
//     guided vendor-app capture (CAPTURE-KEYBOARD.md).
const GET = {
  GET_REPORT: 131,
  GET_PROFILE: 132,
  GET_LEDONOFF: 133,
  GET_DEBOUNCE: 134,
  GET_LEDPARAM: 135,
  GET_SLEDPARAM: 136,
  GET_KBOPTION: 137,
  GET_SLEEPTIME: 145,
  GET_CMD_AUTOOSEN: 151,
  GET_USB_VERSION: 143,
  GET_SKU: 208,
  GET_RF_VERSION: 128, // last — wired board never answers, and that's fine
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** compx-fea: checksum at byte 2 = (0xFF - Σ of every other byte) & 0xFF */
function frame(cmd, args = []) {
  const f = new Array(LEN).fill(0);
  f[0] = 0x00;
  f[1] = cmd;
  args.forEach((a, i) => (f[3 + i] = a)); // args after the checksum byte
  let sum = 0;
  for (let i = 0; i < LEN; i++) if (i !== 2) sum = (sum + f[i]) & 0xff;
  f[2] = (0xff - sum) & 0xff;
  return f;
}

const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** One SetFeature, one GetFeature — the vendor's own pattern. */
async function query(dev, name, cmd) {
  const rec = { name, cmd };
  const q = frame(cmd);
  try {
    await dev.sendFeatureReport(q);
  } catch (e) {
    rec.result = { sendError: String(e.message || e) };
    return rec;
  }
  await sleep(30);
  let d = null;
  try {
    const raw = await dev.getFeatureReport(0x00, LEN);
    if (raw) d = Array.from(raw);
  } catch (e) {
    rec.result = { readError: String(e.message || e) };
    return rec;
  }
  const hex = d ? Buffer.from(d).toString('hex') : null;
  rec.result = {
    query: Buffer.from(q).toString('hex'),
    reply: hex,
    echo: !!d && eq(d, q),
    matchesCmd: !!d && d[1] === cmd,
  };
  await sleep(120); // pace — this firmware wedges under bursty feature I/O
  return rec;
}

async function main() {
  const cols = (await HID.devicesAsync(VID, PID)).filter(
    (d) => d.usagePage === USAGE_PAGE && d.usage === USAGE && d.path,
  );
  if (!cols.length) {
    console.error('R85HE vendor collection not found — is the keyboard connected?');
    console.error('Close SharkDeck / ATK HUB first (they hold the handle).');
    process.exit(1);
  }
  const col = cols[0];
  console.log(
    `R85HE  path=${col.path}\n       serial="${col.serialNumber ?? ''}"  release=0x${(col.release ?? 0).toString(16)}\n`,
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
    note:
      'compx-fea framing (checksum at byte 2). echo=true means the reply is our ' +
      'own query bounced back (firmware did not answer).',
    queries: [],
  };

  const answered = (rec) => rec.result?.matchesCmd && !rec.result?.echo;

  try {
    let echoStreak = 0;
    for (const [name, cmd] of Object.entries(GET)) {
      const rec = await query(dev, name, cmd);
      result.queries.push(rec);
      const ok = answered(rec);
      const wedged = rec.result?.sendError || rec.result?.readError;
      console.log(
        `  ${name.padEnd(18)} cmd ${String(cmd).padStart(3)}  ` +
          (wedged ? `WEDGED (${wedged}) — stopping` : ok ? 'ANSWERED' : '— (echo/none)'),
      );
      if (wedged) break;
      // GET_RF_VERSION genuinely never answers on a wired board — don't count it.
      if (!ok && name !== 'GET_RF_VERSION' && ++echoStreak >= 2) {
        console.log('  two GETs in a row did not answer — stopping before the firmware hangs.');
        break;
      }
      if (ok) echoStreak = 0;
    }
  } finally {
    await dev.close();
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  const n = result.queries.filter(answered).length;
  console.log(`\n${n}/${result.queries.length} queries answered.  ->  ${OUT}`);
  if (n === 0) {
    console.log(
      'Nothing answered — another app holds the channel, or the MI_02 endpoint is wedged (replug the keyboard).',
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
