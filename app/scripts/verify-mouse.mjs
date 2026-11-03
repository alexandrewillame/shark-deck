/**
 * On-hardware verification of the rewritten V8 driver's wire protocol.
 *
 *   node scripts/verify-mouse.mjs            # read + non-destructive write tests
 *   node scripts/verify-mouse.mjs --read     # decode current state only, no writes
 *
 * Speaks the SAME frames `compx-mouse-8k.ts` now produces: 17-byte `0x08`
 * output reports, `0x07` write-setting with a per-field companion byte, `0x08`
 * read-block, `0x2C` receiver LED (one 3-byte frame), `0x16` long-range.
 *
 * For each write test it snapshots the current value, writes a DIFFERENT test
 * value, reads it back, checks both the value and its companion byte landed,
 * then writes the original back. Nothing destructive (no `0x09` factory reset,
 * no `0x05` pairing, no macro writes — those are read-probed only).
 *
 * Requires: the V8 mouse AWAKE (wiggle it), its 8K receiver plugged in, and the
 * vendor Mouse Hub + SharkDeck CLOSED (they hold the collection).
 */
import HID from 'node-hid';

const VID = 0x3554;
const PID = 0xf517;
const USAGE_PAGE = 0xff02;
const USAGE = 0x02;
const LEN = 17;
const READ_ONLY = process.argv.includes('--read');

const CMD = {
  STATUS: 0x03,
  BATTERY: 0x04,
  WRITE: 0x07,
  READ: 0x08,
  RESTORE: 0x09,
  GET_PROFILE: 0x0e,
  SET_PROFILE: 0x0f,
  GET_VERSION: 0x02, // carries nothing — kept only to keep proving it
  DEVICE_VERSION: 0x12, // the mouse's own firmware, answered over the air
  LONG_RANGE: 0x16,
  RX_LED: 0x2c,
  RX_LED_GET: 0x2d,
};

// region-A offsets — mirrors @shared/mouse-wire.ts V8_BLOCK
const A = {
  POLL_RATE: 0x00,
  DPI_STAGE_COUNT: 0x02,
  ACTIVE_DPI_STAGE: 0x04,
  HIGH_FPS: 0x08,
  LOD: 0x0a,
  DPI_REG0: 0x0c,
  DPI_COL0: 0x2c,
  DPI_LED_EFFECT: 0x4c,
  DPI_LED_BRIGHT: 0x4e,
  // INFERRED — see shared/mouse-wire.ts's V8_BLOCK.DPI_LED_SPEED comment.
  // No alternate offset to try: 0x50 is the only unclaimed slot in the DPI-LED
  // field group. What IS worth sweeping is the value range — see the
  // speculative section in main(). The light-strip-shaped block at 0x54..0x5F
  // repeats this group's exact layout, and its speed slot (0x5C) also holds 3.
  DPI_LED_SPEED: 0x50,
  DPI_LED_FLAG: 0x52,
  STRIP_SPEED: 0x5c,
  BUTTON0: 0x60,
  DEBOUNCE: 0xa9,
  MOTION_SYNC: 0xab,
  SLEEP: 0xad,
  ANGLE_SNAP: 0xaf,
  RIPPLE: 0xb1,
  // verified-capture 2026-09-10 — the offset the vendor Hub itself writes when
  // its angle slider moves (docs/reverse-engineering/session-v8-angle.jsonl).
  // 0xB3 was the old guess and is NOT the angle; neither is any other slot in
  // this run, all of which accept a write and read it back unchanged.
  ANGLE_DEGREES: 0xbd,
  SENSOR_MODE: 0xb9,
};
const POLL_WIRE = { 125: 8, 250: 4, 500: 2, 1000: 1, 2000: 16, 4000: 32, 8000: 64 };
const POLL_HZ = Object.fromEntries(Object.entries(POLL_WIRE).map(([h, w]) => [w, +h]));

const sharkSum = (b) => (0x55 - b.reduce((s, x) => s + x, 0)) & 0xff;
const companion = (...bytes) => (0x55 - bytes.reduce((s, b) => s + (b & 0xff), 0)) & 0xff;
// DPI register (verified): reg = dpi/50 - 1; hi byte smears the 2 high bits.
const dpiReg = (dpi) => Math.max(0, Math.round(Math.max(50, Math.min(42000, dpi)) / 50) - 1);
const dpiRegDpi = (lo, hi) => ((lo | (((hi >> 2) & 3) << 8)) + 1) * 50;
const dpiHiWire = (reg) => {
  const hb = (reg >> 8) & 3;
  return (hb << 2) | (hb << 6);
};
const dpiRegBytes = (dpi) => {
  const r = dpiReg(dpi);
  const lo = r & 0xff;
  const hi = dpiHiWire(r);
  return [lo, lo, hi, companion(lo, lo, hi)];
};
const hex = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function frame(cmd, args = []) {
  const f = new Array(LEN).fill(0);
  f[0] = 0x08;
  f[1] = cmd;
  args.forEach((a, i) => (f[2 + i] = a & 0xff));
  f[LEN - 1] = sharkSum(f.slice(0, LEN - 1));
  return f;
}

let dev;
async function exchange(q, cmd, { reads = 8 } = {}) {
  await dev.write(q);
  await sleep(15);
  for (let r = 0; r < reads; r++) {
    let raw;
    try {
      raw = await dev.read(200);
    } catch {
      break;
    }
    if (!raw || raw.length === 0) continue;
    const d = Array.from(raw);
    if (d[1] !== cmd) continue;
    if (d.every((x, i) => x === q[i])) continue; // our own echo
    if (d.every((x) => x === 0)) continue;
    return d;
  }
  return null;
}

// A dozing V8 drops single-field 0x08 reads but reliably answers the Hub-style
// 10-byte chunked sweep, so we snapshot region A (0..0xD7) and slice from it —
// exactly what the driver's regionA() cache does. Re-fetched after each write.
const REGION_A_LEN = 0xd8;
let snapshot = null;
async function refreshSnapshot() {
  for (let attempt = 0; attempt < 4; attempt++) {
    const out = new Uint8Array(REGION_A_LEN);
    let ok = true;
    for (let off = 0; off < REGION_A_LEN; off += 10) {
      const n = Math.min(10, REGION_A_LEN - off);
      const reply = await exchange(frame(CMD.READ, [0x00, 0x00, off & 0xff, n]), CMD.READ);
      if (!reply) {
        ok = false;
        break;
      }
      out.set(reply.slice(6, 6 + n), off);
    }
    if (ok) {
      snapshot = out;
      return snapshot;
    }
    await exchange(frame(CMD.STATUS), CMD.STATUS);
    await sleep(120);
  }
  snapshot = null;
  return null;
}
async function readBlock(offset, length) {
  if (!snapshot) await refreshSnapshot();
  if (snapshot && offset + length <= REGION_A_LEN)
    return Array.from(snapshot.slice(offset, offset + length));
  // outside region A (or snapshot failed) — one direct read
  const reply = await exchange(
    frame(CMD.READ, [0x00, (offset >> 8) & 0xff, offset & 0xff, length & 0xff]),
    CMD.READ,
  );
  return reply ? Array.from(reply.slice(6, 6 + length)) : null;
}
async function readScalar(offset) {
  const b = await readBlock(offset, 1);
  return b ? b[0] : null;
}
async function writeSetting(offset, bytes) {
  const q = frame(CMD.WRITE, [
    0x00,
    (offset >> 8) & 0xff,
    offset & 0xff,
    bytes.length & 0xff,
    ...bytes,
  ]);
  await dev.write(q);
  await sleep(30);
  snapshot = null; // force a re-read so the check sees the device's real state
  return readBlock(offset, bytes.length);
}

let pass = 0;
let fail = 0;
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) pass++;
  else fail++;
  console.log(
    `  ${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}${detail ? `  — ${detail}` : ''}`,
  );
}

/** snapshot -> write test value -> verify value+companion -> restore. */
async function scalarRoundTrip(name, offset, testValue) {
  const orig = await readScalar(offset);
  if (orig === null) return record(name, false, 'could not read current value');
  const back = await writeSetting(offset, [testValue & 0xff, companion(testValue)]);
  const ok = back && back[0] === (testValue & 0xff) && back[1] === companion(testValue);
  record(
    name,
    !!ok,
    ok
      ? `${orig} -> ${testValue} -> restored`
      : `wrote ${testValue}, read back ${back ? hex(back) : 'nothing'}`,
  );
  await writeSetting(offset, [orig & 0xff, companion(orig)]); // restore
}

async function main() {
  const cols = (await HID.devicesAsync(VID, PID)).filter(
    (d) => d.usagePage === USAGE_PAGE && d.usage === USAGE && d.path,
  );
  if (!cols.length) {
    console.error(
      'V8 vendor collection not found — receiver unplugged, or Mouse Hub / SharkDeck holds it.',
    );
    process.exit(1);
  }
  dev = await HID.HIDAsync.open(cols[0].path);
  console.log(`V8  ${cols[0].path}\n`);

  try {
    // --- wait for the mouse to be AWAKE (block reads fail on a sleeping V8) --
    console.log('Waiting for the mouse to be awake — keep moving / clicking it…');
    let status = null;
    for (let i = 0; i < 40; i++) {
      status = await exchange(frame(CMD.STATUS), CMD.STATUS);
      if (status && (status[6] ?? 0) > 0) break;
      await sleep(500);
    }
    console.log('\nLIVENESS');
    record(
      'status 0x03, mouse awake',
      !!status && (status[6] ?? 0) > 0,
      status ? `awake=${status[6]}` : 'no reply',
    );
    if (!status || (status[6] ?? 0) === 0) {
      console.log('\n  Mouse never woke up. Move it continuously and re-run.\n');
      return;
    }
    const batt = await exchange(frame(CMD.BATTERY), CMD.BATTERY);
    console.log(
      `  INFO  battery 0x04: ${batt ? `raw=${batt[6]} mv=${(batt[8] << 8) | batt[9]} charge?=${batt[7]}` : 'no reply'}`,
    );

    // --- decode current region A ----------------------------------
    console.log('\nCURRENT STATE (region A)');
    const pr = await readScalar(A.POLL_RATE);
    const cnt = await readScalar(A.DPI_STAGE_COUNT);
    const act = await readScalar(A.ACTIVE_DPI_STAGE);
    const lod = await readScalar(A.LOD);
    const ms = await readScalar(A.MOTION_SYNC);
    const asn = await readScalar(A.ANGLE_SNAP);
    const rip = await readScalar(A.RIPPLE);
    const hf = await readScalar(A.HIGH_FPS);
    const sm = await readScalar(A.SENSOR_MODE);
    const slp = await readScalar(A.SLEEP);
    const dbn = await readScalar(A.DEBOUNCE);
    const ledE = await readScalar(A.DPI_LED_EFFECT);
    const ledB = await readScalar(A.DPI_LED_BRIGHT);
    const reg0 = await readBlock(A.DPI_REG0, 3);
    const col0 = await readBlock(A.DPI_COL0, 3);
    console.log(`  poll rate      ${pr} -> ${POLL_HZ[pr] ?? '?'} Hz`);
    console.log(`  DPI stages     count=${cnt}  active=${act}`);
    console.log(
      `  DPI stage 1    reg=${reg0 ? hex(reg0) : '?'} -> ${reg0 ? dpiRegDpi(reg0[0], reg0[2]) : '?'} DPI   colour=${col0 ? hex(col0) : '?'}`,
    );
    console.log(`  LOD            ${lod}  (3=0.7mm 1=1mm 2=2mm)`);
    console.log(`  motion sync    ${ms}   angle snap ${asn}   ripple ${rip}   20K scan ${hf}`);
    console.log(`  sensor mode    ${sm}  (0 LP / 1 HP)`);
    console.log(`  sleep timer    ${slp} -> ${slp * 10} s`);
    console.log(`  debounce       ${dbn} ms`);
    console.log(
      `  DPI LED        effect=${ledE}  brightness=${ledB}/255 (${Math.round((ledB / 255) * 100)}%)`,
    );
    for (let i = 0; i < (cnt || 6); i++) {
      const b = await readBlock(A.BUTTON0 + i * 4, 3);
      console.log(`  button slot ${i}  ${b ? hex(b) : '?'}`);
    }

    // --- receiver LED (0x2C echo) + long-range (0x16) ------------
    console.log('\nDEDICATED COMMANDS');
    const rx = await exchange(frame(CMD.RX_LED, [0x00, 0x00, 0x00, 0x00]), CMD.RX_LED);
    record(
      '0x2C receiver-LED probe answers',
      !!rx,
      rx ? `led1=${rx[6]} led2=${rx[7]} led3=${rx[8]}` : 'no reply (write-only?)',
    );
    const lr = await exchange(frame(CMD.LONG_RANGE, [0x00, 0x00, 0x00, 0x0a]), CMD.LONG_RANGE);
    // 0x16 / 0x02 have no captured GET — "no reply" is expected, not a failure.
    console.log(
      `  INFO  0x16 long-range probe: ${lr ? `state=${lr[6]}` : 'no reply (write-only, as in the capture)'}`,
    );
    const fw = await exchange(
      frame(CMD.GET_VERSION, [0x00, 0x00, 0x00, 0x01, 0x01]),
      CMD.GET_VERSION,
    );
    console.log(
      `  INFO  0x02 firmware: ${fw ? hex(fw.slice(0, 10)) : 'no reply / pure echo (expected on V8)'}`,
    );
    // 0x12 is the real one, and the mouse answers it over the air. Byte 2 is
    // 0x00 on a payload and 0x01 on the dongle's generic ACK.
    const own = await exchange(frame(CMD.DEVICE_VERSION), CMD.DEVICE_VERSION);
    record(
      'device firmware 0x12',
      !!own && own[2] === 0x00 && own[5] >= 2,
      own
        ? own[2] === 0x00
          ? `v${own[6]}.${own[7].toString(16).padStart(2, '0')} (from the mouse, over the link)`
          : 'generic ACK — the dongle answered, the mouse did not (asleep?)'
        : 'no reply (mouse asleep?)',
    );

    // ---- read-block replies must identify themselves ----------------------
    // The whole region-A read path depends on this: every offset is read with
    // the same command byte, so a reply is only attributable if it echoes the
    // offset (bytes 3-4) and length (byte 5) it answers. The driver filters on
    // exactly this (CompxMouse8K.blockReplyFor), and without it a foreign 0x08
    // frame — our own concurrent sweep, or the vendor Hub polling the same
    // mouse on its own handle — gets diffed against a write and reported as
    // "did not read back as written".
    {
      const probes = [
        [0x00, 10],
        [0x4c, 8],
        [0xa9, 2],
        [0x0100, 10],
      ];
      const bad = [];
      for (const [off, len] of probes) {
        const q = frame(CMD.READ, [0x00, (off >> 8) & 0xff, off & 0xff, len]);
        const r = await exchange(q, CMD.READ);
        if (!r) bad.push(`0x${off.toString(16)} no reply`);
        else if (((r[3] << 8) | r[4]) !== off || r[5] !== len) {
          bad.push(
            `0x${off.toString(16)} echoed 0x${(((r[3] << 8) | r[4]) >>> 0).toString(16)}/${r[5]}`,
          );
        }
      }
      record(
        '0x08 replies echo their own offset+length',
        bad.length === 0,
        bad.length === 0 ? `${probes.length}/${probes.length} matched` : bad.join(', '),
      );
    }

    if (READ_ONLY) {
      console.log('\n--read: skipping write tests.');
      return;
    }

    // --- non-destructive write round-trips ----------------------
    console.log('\nWRITE ROUND-TRIPS (value written, read back, then restored)');
    // poll rate: flip to a neighbouring value
    {
      const orig = await readScalar(A.POLL_RATE);
      const test = orig === POLL_WIRE[1000] ? POLL_WIRE[500] : POLL_WIRE[1000];
      const back = await writeSetting(A.POLL_RATE, [test, companion(test)]);
      const ok = back && back[0] === test && back[1] === companion(test);
      record(
        'poll rate 0x07 @ 0x00',
        !!ok,
        ok
          ? `${POLL_HZ[orig]}Hz -> ${POLL_HZ[test]}Hz -> restored`
          : `read back ${back ? hex(back) : 'nothing'}`,
      );
      await writeSetting(A.POLL_RATE, [orig, companion(orig)]);
    }
    await scalarRoundTrip('LOD 0x07 @ 0x0A', A.LOD, (await readScalar(A.LOD)) === 2 ? 1 : 2);
    await scalarRoundTrip(
      'motion sync 0x07 @ 0xAB',
      A.MOTION_SYNC,
      (await readScalar(A.MOTION_SYNC)) ? 0 : 1,
    );
    await scalarRoundTrip(
      'angle snap 0x07 @ 0xAF',
      A.ANGLE_SNAP,
      (await readScalar(A.ANGLE_SNAP)) ? 0 : 1,
    );
    await scalarRoundTrip('ripple 0x07 @ 0xB1', A.RIPPLE, (await readScalar(A.RIPPLE)) ? 0 : 1);
    await scalarRoundTrip(
      '20K scan 0x07 @ 0x08',
      A.HIGH_FPS,
      (await readScalar(A.HIGH_FPS)) ? 0 : 1,
    );
    await scalarRoundTrip(
      'sensor mode 0x07 @ 0xB9',
      A.SENSOR_MODE,
      (await readScalar(A.SENSOR_MODE)) ? 0 : 1,
    );
    await scalarRoundTrip(
      'sleep timer 0x07 @ 0xAD',
      A.SLEEP,
      (await readScalar(A.SLEEP)) === 90 ? 30 : 90,
    );
    await scalarRoundTrip(
      'debounce 0x07 @ 0xA9',
      A.DEBOUNCE,
      (await readScalar(A.DEBOUNCE)) >= 8 ? 2 : 10,
    );
    await scalarRoundTrip(
      'DPI LED effect 0x07 @ 0x4C',
      A.DPI_LED_EFFECT,
      (await readScalar(A.DPI_LED_EFFECT)) === 2 ? 1 : 2,
    );
    await scalarRoundTrip(
      'DPI LED brightness 0x07 @ 0x4E',
      A.DPI_LED_BRIGHT,
      (await readScalar(A.DPI_LED_BRIGHT)) > 128 ? 64 : 200,
    );
    await scalarRoundTrip(
      'active DPI stage 0x07 @ 0x04',
      A.ACTIVE_DPI_STAGE,
      (await readScalar(A.ACTIVE_DPI_STAGE)) === 0 ? 1 : 0,
    );
    // ---- angle mode: 0xBD, confirmed against the vendor Hub ---------------
    // A real round trip now: 0xBD is the offset the Hub writes, so this both
    // reads back AND moves the mouse's angle. Two's complement, so exercise
    // the negative half too — that is the part a byte comparison would miss.
    await scalarRoundTrip(
      'mouse angle 0x07 @ 0xBD (+30)',
      A.ANGLE_DEGREES,
      (await readScalar(A.ANGLE_DEGREES)) === 30 ? 15 : 30,
    );
    await scalarRoundTrip('mouse angle 0x07 @ 0xBD (-30)', A.ANGLE_DEGREES, 0xe2);
    await scalarRoundTrip('mouse angle 0x07 @ 0xBD (0 = off)', A.ANGLE_DEGREES, 0);

    // ---- 0x50: which VALUES the byte accepts, not which offset ------------
    // The driver clamps to 1..3 because 3 is the only value ever observed
    // here; this is what confirms or widens that. A value that reads back is
    // still only necessary, not sufficient — watch the LED (see below).
    {
      const orig = await readScalar(A.DPI_LED_SPEED);
      const accepted = [];
      for (const v of [0, 1, 2, 3, 4, 5]) {
        const back = await writeSetting(A.DPI_LED_SPEED, [v, companion(v)]);
        if (back && back[0] === v && back[1] === companion(v)) accepted.push(v);
      }
      if (orig !== null) await writeSetting(A.DPI_LED_SPEED, [orig, companion(orig)]);
      record(
        '[SPECULATIVE] DPI LED speed 0x07 @ 0x50 — value sweep',
        accepted.length > 0,
        accepted.length
          ? `default ${orig}; accepted ${accepted.join(', ')} (driver band is 1..3 — widen DPI_LED_SPEED_WIRE if this is broader)`
          : `default ${orig}; the firmware refused every value 0..5 — 0x50 is not the speed byte`,
      );
      if (accepted.length) {
        console.log(
          '  NOTE  set the DPI LED to Breathing and re-run, watching the LED: a byte that',
        );
        console.log('        reads back is not proof the firmware acts on it.');
      }
    }

    // ---- 0x52: is it an on/off gate, or does it simply not stick? ---------
    // It reads 00 in every factory profile while 0x4C reads 02, so the "gate"
    // reading cannot be assumed. The Hub wrote 01 here exactly once and the
    // post-image shows it back at 00. Settle it by watching the LED.
    {
      const origEff = await readScalar(A.DPI_LED_EFFECT);
      const origFlag = await readScalar(A.DPI_LED_FLAG);
      await writeSetting(A.DPI_LED_EFFECT, [2, companion(2)]); // breathing
      const off = await writeSetting(A.DPI_LED_FLAG, [0, companion(0)]);
      console.log(
        `  LOOK  0x4C=02 (breathing), 0x52=00 -> read back ${off ? hex(off) : 'nothing'}. Is the LED lit?`,
      );
      await sleep(1500);
      const on = await writeSetting(A.DPI_LED_FLAG, [1, companion(1)]);
      console.log(
        `  LOOK  0x4C=02 (breathing), 0x52=01 -> read back ${on ? hex(on) : 'nothing'}. Did it change?`,
      );
      await sleep(1500);
      const sticks = on && on[0] === 1;
      record(
        '[SPECULATIVE] DPI LED flag 0x07 @ 0x52 — sticks?',
        !!sticks,
        sticks
          ? 'the byte holds 01; if the LED also changed it is a gate, and readDpiLed should honour it'
          : 'the byte does not hold — the driver is right not to interpret it',
      );
      if (origEff !== null) await writeSetting(A.DPI_LED_EFFECT, [origEff, companion(origEff)]);
      if (origFlag !== null) await writeSetting(A.DPI_LED_FLAG, [origFlag, companion(origFlag)]);
    }

    // ---- 0x2D: the receiver-LED GET ---------------------------------------
    // Both direct-probe captures show `08 2d 00 00 00 0a <a> <b> <c>` answering
    // a bare probe with the live triple, while 0x2C answers the generic ACK.
    // This is the one test that decides the Receiver LED pane.
    {
      const before = await exchange(
        frame(CMD.RX_LED_GET, [0x00, 0x00, 0x00, 0x00]),
        CMD.RX_LED_GET,
      );
      const isData = before && before[2] !== 0x01 && before[5] >= 3;
      const orig = isData ? [before[6], before[7], before[8]] : null;
      console.log(`  INFO  0x2d probe: ${before ? hex(before.slice(0, 10)) : 'no reply'}`);
      const echo = await exchange(frame(CMD.RX_LED, [0x00, 0x00, 0x00, 0x0a]), CMD.RX_LED);
      console.log(
        `  INFO  0x2c len-0x0a read shape: ${echo ? hex(echo.slice(0, 10)) : 'no reply'}`,
      );
      if (!orig) {
        record(
          '0x2D receiver-LED GET',
          false,
          'no data reply — the Receiver LED pane stays on last-write/unknown',
        );
      } else {
        // Write a DIFFERENT triple and see whether 0x2D follows it.
        const test = [orig[0] === 2 ? 3 : 2, orig[1], orig[2]];
        await dev.write(frame(CMD.RX_LED, [0x00, 0x00, 0x00, 0x0a, ...test]));
        await sleep(60);
        const after = await exchange(
          frame(CMD.RX_LED_GET, [0x00, 0x00, 0x00, 0x00]),
          CMD.RX_LED_GET,
        );
        const got = after && after[5] >= 3 ? [after[6], after[7], after[8]] : null;
        const ok = got && got.every((v, i) => v === test[i]);
        record(
          '0x2D receiver-LED GET',
          !!ok,
          ok
            ? `${orig.join(',')} -> ${test.join(',')} read back, then restored`
            : `wrote ${test.join(',')}, 0x2D reports ${got ? got.join(',') : 'nothing'}`,
        );
        await dev.write(frame(CMD.RX_LED, [0x00, 0x00, 0x00, 0x0a, ...orig]));
        await sleep(60);
      }
    }

    // DPI stage-1 register — exercise the low range AND the high-DPI smeared
    // hi byte (20000 -> 8f 8f 44). reg = dpi/50 - 1.
    {
      const orig = await readBlock(A.DPI_REG0, 3);
      if (orig) {
        const curDpi = dpiRegDpi(orig[0], orig[2]);
        const restore = [orig[0], orig[0], orig[2], companion(orig[0], orig[0], orig[2])];
        for (const testDpi of [1600, 20000]) {
          const payload = dpiRegBytes(testDpi);
          const back = await writeSetting(A.DPI_REG0, payload);
          const ok =
            back && back[0] === payload[0] && back[1] === payload[1] && back[2] === payload[2];
          record(
            `DPI stage-1 register 0x07 @ 0x0C -> ${testDpi}`,
            !!ok,
            ok
              ? `read back ${dpiRegDpi(back[0], back[2])} DPI`
              : `wrote ${hex(payload)}, read ${back ? hex(back) : 'nothing'}`,
          );
        }
        await writeSetting(A.DPI_REG0, restore);
        record('DPI stage-1 restored', true, `${curDpi} DPI`);
      } else {
        record('DPI stage-1 register 0x07 @ 0x0C', false, 'could not read current register');
      }
    }
    // DPI stage-1 colour (RGB + companion)
    {
      const orig = await readBlock(A.DPI_COL0, 3);
      if (orig) {
        const t = [orig[0], orig[1], orig[2]].join() === '0,255,0' ? [0, 0, 255] : [0, 255, 0];
        const back = await writeSetting(A.DPI_COL0, [...t, companion(...t)]);
        const ok = back && back[0] === t[0] && back[1] === t[1] && back[2] === t[2];
        record(
          'DPI stage-1 colour 0x07 @ 0x2C',
          !!ok,
          ok ? `${hex(orig)} -> ${hex(t)} -> restored` : `read ${back ? hex(back) : 'nothing'}`,
        );
        await writeSetting(A.DPI_COL0, [
          orig[0],
          orig[1],
          orig[2],
          companion(orig[0], orig[1], orig[2]),
        ]);
      } else record('DPI stage-1 colour 0x07 @ 0x2C', false, 'could not read current colour');
    }
    // button slot 0 (action byte only, safe values)
    {
      const orig = await readBlock(A.BUTTON0, 3);
      if (orig) {
        const t = orig[0] === 2 ? [7, 0, 0] : [2, 1, 0]; // poll-switch vs DPI-loop
        const back = await writeSetting(A.BUTTON0, [...t, companion(...t)]);
        const ok = back && back[0] === t[0] && back[1] === t[1];
        record(
          'button slot 0 0x07 @ 0x60',
          !!ok,
          ok ? `action ${orig[0]} -> ${t[0]} -> restored` : `read ${back ? hex(back) : 'nothing'}`,
        );
        await writeSetting(A.BUTTON0, [
          orig[0],
          orig[1],
          orig[2],
          companion(orig[0], orig[1], orig[2]),
        ]);
      } else record('button slot 0 0x07 @ 0x60', false, 'could not read current mapping');
    }

    // receiver LED: write current values back (a no-op change) to prove the frame is accepted
    if (rx) {
      const f = frame(CMD.RX_LED, [0x00, 0x00, 0x00, 0x0a, rx[6], rx[7], rx[8]]);
      await dev.write(f);
      await sleep(30);
      const back = await exchange(frame(CMD.RX_LED, [0x00, 0x00, 0x00, 0x00]), CMD.RX_LED);
      const ok = back && back[6] === rx[6] && back[7] === rx[7] && back[8] === rx[8];
      record(
        '0x2C receiver-LED write (no-op)',
        !!ok,
        ok ? `held ${rx[6]}/${rx[7]}/${rx[8]}` : 'value drifted',
      );
    }
    // long-range: toggle and toggle back
    if (lr) {
      const orig = lr[6];
      await dev.write(frame(CMD.LONG_RANGE, [0x00, 0x00, 0x00, 0x0a, orig ? 0 : 1]));
      await sleep(50);
      const mid = await exchange(frame(CMD.LONG_RANGE, [0x00, 0x00, 0x00, 0x0a]), CMD.LONG_RANGE);
      await dev.write(frame(CMD.LONG_RANGE, [0x00, 0x00, 0x00, 0x0a, orig]));
      record(
        '0x16 long-range toggle',
        !!mid && mid[6] === (orig ? 0 : 1),
        mid ? `${orig} -> ${mid[6]} -> restored` : 'no read-back',
      );
    }
  } finally {
    await dev.close();
  }

  console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailed:');
    for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
