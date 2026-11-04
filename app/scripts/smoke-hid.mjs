/**
 * Hardware smoke test — no Electron. Enumerates real Attack Shark collections,
 * opens the vendor channel, and does read-only queries (active profile,
 * battery, firmware). Run with a V8 dongle and/or R85HE connected:
 *
 *   node scripts/smoke-hid.mjs
 *
 * Discovery modes, for identifying a not-yet-catalogued device (e.g. the V8
 * mouse's wired-USB interface, distinct from its 2.4GHz dongle):
 *
 *   node scripts/smoke-hid.mjs --list
 *     Dump every HID collection at a known Attack Shark VID, or whose
 *     product/manufacturer string looks like one, with every field a catalog
 *     entry needs.
 *
 *   node scripts/smoke-hid.mjs --watch
 *     Re-enumerate every second and print only what changed (+ appeared,
 *     - vanished). Start it with a cable unplugged, then plug it in — the new
 *     `+` lines are the wired interface's vid/pid/usagePage/usage.
 *
 *   node scripts/smoke-hid.mjs --probe <vid>:<pid>
 *     Open that vid:pid's vendor collection and send the V8's verified
 *     STATUS (0x03) / BATTERY (0x04) / GET_PROFILE (0x0e) commands, printing
 *     raw hex replies — answers "does this interface speak the same 17-byte
 *     0x08 protocol as the dongle".
 *
 * Uses node-hid's async API throughout (HIDAsync / devicesAsync) so this
 * script exercises the same code path the app itself now uses — see
 * src/main/hid/transport.ts.
 */
import HID from 'node-hid';

const ATTACK_SHARK_VIDS = new Set([0x3554, 0x3151]);
const NAME_HINT = /shark|compx/i;

const TARGETS = [
  {
    name: 'Attack Shark V8 (mouse, 2.4G dongle)',
    vid: 0x3554,
    pid: 0xf517,
    usagePage: 0xff02,
    usage: 0x02,
    reportLen: 17,
    id: 0x08,
    mode: 'output',
  },
  // Same mouse over USB-C — a different endpoint with the same serial and the
  // same protocol; SharkDeck merges the two into one card (devices/manager.ts).
  {
    name: 'Attack Shark V8 (mouse, USB-C)',
    vid: 0x3554,
    pid: 0xf515,
    usagePage: 0xff02,
    usage: 0x02,
    reportLen: 17,
    id: 0x08,
    mode: 'output',
  },
  {
    name: 'Attack Shark R85HE (keyboard)',
    vid: 0x3151,
    pid: 0x5029,
    usagePage: 0xffff,
    usage: 0x02,
    reportLen: 65,
    id: 0x00,
    mode: 'feature',
  },
];

const sharkSum = (b) => (0x55 - b.reduce((s, x) => s + x, 0)) & 0xff;
/** compx-fea, the keyboard scheme (src/main/hid/checksum.ts): 0xFF - Σ bytes[1..7], at byte 8. */
const feaSum = (b) => (0xff - b.slice(1, 8).reduce((s, x) => s + x, 0)) & 0xff;

function frame(id, len, cmd, args = []) {
  const f = new Array(len).fill(0);
  f[0] = id;
  f[1] = cmd;
  args.forEach((a, i) => (f[2 + i] = a));
  if (id === 0x08) f[len - 1] = sharkSum(f.slice(0, len - 1));
  // The keyboard firmware ignores a GET without its checksum and Windows then
  // hands back our own SET buffer — so unsigned, every R85HE line below read
  // "no answer / echo". Confirmed again over WebHID, 2026-11-03.
  else f[8] = feaSum(f);
  return f;
}

async function readMatch(dev, cmd, mode, query, tries = 4) {
  for (let t = 0; t < tries; t++) {
    for (let r = 0; r < 6; r++) {
      try {
        const raw = mode === 'feature' ? await dev.getFeatureReport(0x00, 65) : await dev.read(250);
        if (!raw) continue;
        const d = Array.from(raw);
        if (d[1] !== cmd) continue;
        // In feature mode Windows echoes our own SetFeature buffer when the
        // firmware does not answer (wrong checksum / asleep). Ignore that —
        // accepting it is what used to print "v0.00".
        if (query && d.length === query.length && d.every((b, i) => b === query[i])) continue;
        return d;
      } catch {
        break;
      }
    }
  }
  return null;
}

/** raw uint16 firmware -> "v{maj}.{min}" (vendor hex-digits-as-decimal scheme). */
function fmtVersion(raw) {
  const dec = parseInt(raw.toString(16), 10);
  return `v${Math.floor(dec / 100)}.${String(dec % 100).padStart(2, '0')}`;
}

async function send(dev, mode, f) {
  if (mode === 'feature') await dev.sendFeatureReport(f);
  else await dev.write(f);
}

function fmtCollection(d) {
  const hex = (n) => (n === undefined || n === null ? '----' : n.toString(16).padStart(4, '0'));
  return (
    `vid=${hex(d.vendorId)} pid=${hex(d.productId)} up=${hex(d.usagePage)} usg=${hex(d.usage)} ` +
    `if=${d.interface ?? -1} rel=${hex(d.release)} serial="${d.serialNumber ?? ''}" ` +
    `product="${d.product ?? ''}" manufacturer="${d.manufacturer ?? ''}"\n    path=${d.path ?? ''}`
  );
}

function isSharkish(d) {
  return (
    ATTACK_SHARK_VIDS.has(d.vendorId) ||
    NAME_HINT.test(d.product ?? '') ||
    NAME_HINT.test(d.manufacturer ?? '')
  );
}

async function runList() {
  const all = await HID.devicesAsync();
  const mine = all.filter(isSharkish);
  if (mine.length === 0) {
    console.log('No Attack Shark / Compx-looking collections found.');
    return;
  }
  console.log(`${mine.length} collection(s):\n`);
  for (const d of mine) console.log('  ' + fmtCollection(d));
  console.log('\n--- paste this if reporting a new device ---');
  for (const d of mine) {
    console.log(
      `{ vid: 0x${d.vendorId.toString(16)}, pid: 0x${d.productId.toString(16)}, usagePage: 0x${(d.usagePage ?? 0).toString(16)}, usage: 0x${(d.usage ?? 0).toString(16)}, product: '${d.product ?? ''}' }`,
    );
  }
}

async function runWatch() {
  console.log('Watching for HID changes every 1s — plug/unplug the device now. Ctrl+C to stop.\n');
  const key = (d) =>
    `${d.vendorId.toString(16)}:${d.productId.toString(16)}:${d.usagePage ?? ''}:${d.usage ?? ''}:${d.path ?? ''}`;
  let prev = new Map();
  // Prime the baseline silently, then report every subsequent diff.
  for (const d of await HID.devicesAsync()) prev.set(key(d), d);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const cur = new Map();
    for (const d of await HID.devicesAsync()) cur.set(key(d), d);
    for (const [k, d] of cur) {
      if (!prev.has(k)) console.log(`+ ${fmtCollection(d)}`);
    }
    for (const [k, d] of prev) {
      if (!cur.has(k)) console.log(`- ${fmtCollection(d)}`);
    }
    prev = cur;
  }
}

async function runProbe(spec) {
  const [vidStr, pidStr] = spec.split(':');
  const vid = parseInt(vidStr, 16);
  const pid = parseInt(pidStr, 16);
  if (!vid || !pid) {
    console.log(`Usage: --probe <vid_hex>:<pid_hex>, e.g. --probe 3554:f517`);
    return;
  }
  const cols = (await HID.devicesAsync()).filter(
    (d) => d.vendorId === vid && d.productId === pid && d.path,
  );
  if (cols.length === 0) {
    console.log(`No collection found for ${vidStr}:${pidStr}.`);
    return;
  }
  // Prefer a vendor-looking usage page (0xff00+) if there's more than one
  // collection for this vid:pid; otherwise just take the first.
  const col = cols.find((c) => (c.usagePage ?? 0) >= 0xff00) ?? cols[0];
  console.log(`Probing ${vidStr}:${pidStr} — ${fmtCollection(col)}\n`);
  let dev;
  try {
    dev = await HID.HIDAsync.open(col.path);
  } catch (e) {
    console.log(`open failed: ${e.message}`);
    return;
  }
  const REPORT_LEN = 17;
  const send17 = async (cmd, args = []) => {
    const f = frame(0x08, REPORT_LEN, cmd, args);
    await dev.write(f);
    return f;
  };
  try {
    for (const [label, cmd] of [
      ['STATUS (0x03)', 0x03],
      ['BATTERY (0x04)', 0x04],
      ['GET_PROFILE (0x0e)', 0x0e],
    ]) {
      const q = await send17(cmd);
      const reply = await readMatch(dev, cmd, 'output', q);
      console.log(`${label}: ${reply ? Buffer.from(reply).toString('hex') : 'no reply'}`);
    }
  } finally {
    await dev.close();
  }
}

async function runDefault() {
  let found = 0;
  for (const t of TARGETS) {
    const cols = (await HID.devicesAsync(t.vid, t.pid)).filter(
      (d) => d.usagePage === t.usagePage && d.usage === t.usage && d.path,
    );
    if (cols.length === 0) {
      console.log(`— ${t.name}: not connected`);
      continue;
    }
    found++;
    console.log(`\n✓ ${t.name}`);
    console.log(`  path      ${cols[0].path}`);
    console.log(`  serial    ${cols[0].serialNumber ?? '(none)'}`);
    let dev;
    try {
      dev = await HID.HIDAsync.open(cols[0].path);
    } catch (e) {
      console.log(`  open failed: ${e.message}`);
      continue;
    }
    try {
      if (t.id === 0x08) {
        const qp = frame(t.id, t.reportLen, 0x0e);
        await send(dev, t.mode, qp);
        const p = await readMatch(dev, 0x0e, t.mode, qp);
        console.log(`  profile   ${p ? p[6] + 1 : 'no answer (mouse asleep?)'}`);
        const qb = frame(t.id, t.reportLen, 0x04);
        await send(dev, t.mode, qb);
        const b = await readMatch(dev, 0x04, t.mode, qb);
        console.log(`  battery   ${b && b[6] <= 100 ? b[6] + '%' : 'no answer'}`);
        // Two versions, two sources. The endpoint's own `bcdDevice` is the
        // receiver's over a dongle and the mouse's over USB-C. Command 0x12 is
        // the MOUSE's, answered by the mouse itself on either transport — so
        // over a dongle the two genuinely differ, and printing both is the
        // point. (0x02 is not it: at every selector and length it answers only
        // an echo or the generic ACK, hardware-probed 2026-09-07, which is what
        // an older decode here turned into a bogus "v0.00".)
        const rel = cols[0].release ?? 0;
        const side = t.pid === 0xf515 ? 'device' : 'receiver';
        console.log(
          `  ${side.padEnd(8)}  ${rel ? `${fmtVersion(rel)}  (from the USB descriptor)` : 'not reported'}`,
        );
        const qv = frame(t.id, t.reportLen, 0x12);
        await send(dev, t.mode, qv);
        const v = await readMatch(dev, 0x12, t.mode, qv);
        // Byte 2 is 0x01 on the dongle's generic ACK, 0x00 on a real payload.
        const own = v && v[2] === 0x00 ? (v[6] << 8) | v[7] : 0;
        console.log(
          `  device    ${own ? `${fmtVersion(own)}  (from the mouse, command 0x12)` : 'no answer (mouse asleep?)'}`,
        );
      } else {
        const qp = frame(t.id, t.reportLen, 132); // GET_PROFILE
        await send(dev, t.mode, qp);
        const p = await readMatch(dev, 132, t.mode, qp);
        console.log(`  profile   ${p ? p[2] + 1 : 'no answer / echo'}`);
        // Offsets as the driver reads them (CompxKeyboard.getFirmware): model id
        // at [2..3] LE, firmware at [8..9] LE — `00 8f 33 0c … 11 05` is model
        // 3123 (the R85HE), firmware v5.11.
        const qv = frame(t.id, t.reportLen, 143); // GET_USB_VERSION
        await send(dev, t.mode, qv);
        const v = await readMatch(dev, 143, t.mode, qv);
        console.log(
          `  firmware  ${v ? `${fmtVersion((v[9] << 8) | v[8])}  (model id ${(v[3] << 8) | v[2]})` : 'no answer / echo'}`,
        );
        const qr = frame(t.id, t.reportLen, 128); // GET_RF_VERSION
        await send(dev, t.mode, qr);
        const rf = await readMatch(dev, 128, t.mode, qr);
        const rfv = rf ? (rf[3] << 8) | rf[2] : 0;
        console.log(`  receiver  ${rfv ? fmtVersion(rfv) : 'none (wired)'}`);
        const ql = frame(t.id, t.reportLen, 135); // GET_LEDPARAM
        await send(dev, t.mode, ql);
        const l = await readMatch(dev, 135, t.mode, ql);
        console.log(
          `  ledparam  ${l ? Buffer.from(l.slice(1, 10)).toString('hex') : 'no answer / echo'}`,
        );
      }
    } finally {
      await dev.close();
    }
  }
  console.log(`\n${found} Attack Shark device(s) reachable.`);
}

const args = process.argv.slice(2);
if (args.includes('--list')) await runList();
else if (args.includes('--watch')) await runWatch();
else if (args.includes('--probe')) await runProbe(args[args.indexOf('--probe') + 1] ?? '');
else await runDefault();
