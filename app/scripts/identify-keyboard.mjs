/**
 * Identify a connected ROYUAN / Attack Shark keyboard by the model id its
 * firmware reports, and cross-reference it against both extracted device
 * registries.
 *
 *   node scripts/identify-keyboard.mjs              # identity only (safe)
 *   node scripts/identify-keyboard.mjs --pages      # also dump magnetic state
 *   node scripts/identify-keyboard.mjs --out p.json
 *
 * WHY: VID/PID does not identify these boards. ~99 keyboards share
 * 0x3151:0x5029, and the vendor tools disambiguate on a model id read from the
 * firmware — qmk.top's `whoAmI` sends GET_USB_VERSION and matches the reply
 * against the `id` field of its device table. That is why an R86PROHE plugged
 * into SharkDeck today resolves to the *R85HE* descriptor.
 *
 * The reply is `[00, 8f, <id lo>, <id hi>, 00, 00, 00, 00, <fw lo>, <fw hi>, …]`
 * — verified against a real R85HE (id 0x0c33 = 3123, fw 0x0511 -> "v5.11").
 * qmk.top reads the id as a uint32 over bytes [2..5]; the app reads a uint16
 * over [2..3]. Both are printed: they agree for every id in the registries
 * (all < 65536), and the uint32 is the safer read.
 *
 * READ-ONLY. Every command sent here is a GET.
 */
import fs from 'node:fs';
import path from 'node:path';
import HID from 'node-hid';
import {
  answered,
  hex,
  openVendorCollection,
  payloadStart,
  query,
  sleep,
} from './lib/compx-fea.mjs';

const WANT_PAGES = process.argv.includes('--pages');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : null;

// Vendor ids seen across the ROYUAN registries (0x3151 is COMPX itself).
const VIDS = [0x3151, 0x3554, 0x39ab, 0x046a];

const CMD = {
  GET_USB_VERSION: 143,
  GET_REV: 240,
  GET_PROFILE: 132,
  GET_DEBOUNCE: 134,
  GET_REPORT: 131,
  GET_KBOPTION: 137,
  GET_KEY_MAGNETISM_MODE: 157,
  GET_MULTI_MAGNETISM: 229,
};

const RATE = { 0: 8000, 1: 4000, 2: 2000, 3: 1000, 4: 500, 5: 250, 6: 125 };
const MAG_MODE = { 0: 'comfort', 1: 'sensitive', 2: 'gaming', 3: 'custom' };
// [page, name, chunks] — chunk counts are the vendor's own
// (KB_MAGNETISM_PAGE_CHUNKS); chunks/2 = bytes per key over 128 slots.
const PAGES = [
  [7, 'modeByte', 2],
  [0, 'pressActuation', 4],
  [1, 'releasePoint', 4],
  [2, 'rapidTriggerPress', 4],
  [3, 'rapidTriggerRelease', 4],
  [6, 'deadZoneBottom', 4],
  [251, 'deadZoneTop', 2],
  [252, 'switchType', 2],
];

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
  } catch {
    return null;
  }
};

/** Vendor renders the raw uint16's hex digits as decimal: 0x0511 -> "v5.11". */
const fmtVersion = (raw) => {
  const s = raw.toString(16);
  return `v${s.slice(0, -2) || '0'}.${s.slice(-2).padStart(2, '0')}`;
};

function lookup(modelId) {
  const hits = [];
  const qmk = readJson('scripts/_raw/qmk-devices.json') ?? [];
  for (const d of qmk) {
    if (d.id === modelId) hits.push({ registry: 'qmk.top', ...d });
  }
  const kb = readJson('scripts/_raw/kb-devices.json') ?? [];
  for (const d of kb) {
    if (d.id === modelId) hits.push({ registry: 'driver-v4', ...d });
  }
  return hits;
}

async function identify(col) {
  const dev = await HID.HIDAsync.open(col.path);
  const info = {
    vid: col.vendorId,
    pid: col.productId,
    vidHex: '0x' + col.vendorId.toString(16).padStart(4, '0'),
    pidHex: '0x' + col.productId.toString(16).padStart(4, '0'),
    product: col.product ?? null,
    manufacturer: col.manufacturer ?? null,
    serial: col.serialNumber ?? null,
    release: col.release ?? null,
    path: col.path,
    queries: {},
  };

  try {
    const v = await query(dev, CMD.GET_USB_VERSION);
    info.queries.GET_USB_VERSION = { reply: v.reply, echo: v.echo, matchesCmd: v.matchesCmd };
    if (answered(v)) {
      const b = v.bytes;
      info.modelIdU32 = (b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24)) >>> 0;
      info.modelIdU16 = b[2] | (b[3] << 8);
      info.firmwareRaw = b[8] | (b[9] << 8);
      info.firmware = info.firmwareRaw ? fmtVersion(info.firmwareRaw) : null;
      info.decodingsAgree = info.modelIdU32 === info.modelIdU16;
      info.matches = lookup(info.modelIdU32 === 0xffffffff ? -1 : info.modelIdU32);
    }

    for (const [name, cmd] of [
      ['GET_REV', CMD.GET_REV],
      ['GET_PROFILE', CMD.GET_PROFILE],
      ['GET_DEBOUNCE', CMD.GET_DEBOUNCE],
      ['GET_REPORT', CMD.GET_REPORT],
      ['GET_KBOPTION', CMD.GET_KBOPTION],
      ['GET_KEY_MAGNETISM_MODE', CMD.GET_KEY_MAGNETISM_MODE],
    ]) {
      const r = await query(dev, cmd);
      info.queries[name] = { reply: r.reply, echo: r.echo, matchesCmd: r.matchesCmd };
      if (!answered(r)) continue;
      const b = r.bytes;
      const p = payloadStart(b, cmd);
      if (name === 'GET_REPORT') info.reportRateHz = RATE[b[3]] ?? null;
      if (name === 'GET_PROFILE') info.activeProfile = b[p] + 1;
      if (name === 'GET_DEBOUNCE') info.debounceMs = b[3];
      if (name === 'GET_KEY_MAGNETISM_MODE') info.keyMagnetismMode = MAG_MODE[b[2]] ?? b[2];
      if (name === 'GET_KBOPTION') {
        // [1]=FnOS [2]=fnProfile [3]=anti-mistouch [4]=RTStab/25 [5]=swapWASD
        info.kbOption = {
          fnOs: b[2],
          fnProfile: b[3],
          antiMistouch: b[4] === 1,
          rtStab: b[5] > 5 ? 0 : b[5] * 25,
          swapWasd: b[6] === 1,
          raw: hex(b.slice(1, 8)),
        };
      }
    }

    if (WANT_PAGES) {
      // A paged GET_MULTI_MAGNETISM reply is 64 RAW data bytes starting at
      // byte 1 — no command echo, no checksum. So `answered()` (which tests
      // reply[1] === cmd) must not be used here; it rejects every valid frame.
      // 128 slots per page, `chunks / 2` bytes per key.
      const mult = info.firmwareRaw < 768 ? 10 : info.firmwareRaw < 1280 ? 100 : 200;
      info.travelMultiplier = mult;
      info.magnetism = {};
      for (const [page, name, chunks] of PAGES) {
        const width = Math.max(1, Math.round(chunks / 2));
        const bytes = [];
        for (let c = 0; c < chunks; c++) {
          const r = await query(dev, CMD.GET_MULTI_MAGNETISM, [page, 1, c]);
          if (!r.bytes) break;
          bytes.push(...r.bytes.slice(1));
          await sleep(40);
        }
        const vals = [];
        for (let i = 0; i + width <= bytes.length; i += width) {
          let v = 0;
          for (let b = 0; b < width; b++) v |= bytes[i + b] << (8 * b);
          vals.push(v >>> 0);
        }
        const distinct = [...new Set(vals)];
        info.magnetism[name] = {
          page,
          width,
          slots: vals.length,
          nonZero: vals.filter((v) => v !== 0).length,
          distinct: distinct.slice(0, 8),
          // travel pages are mm * multiplier; the 1-byte pages are not
          mm: width === 2 ? distinct.slice(0, 8).map((v) => +(v / mult).toFixed(2)) : null,
          first16: vals.slice(0, 16),
        };
      }
    }
  } finally {
    await dev.close();
  }
  return info;
}

async function main() {
  let cols = [];
  for (const vid of VIDS) cols.push(...(await openVendorCollection(HID, { vid })));
  // de-dup by path
  cols = [...new Map(cols.map((c) => [c.path, c])).values()];

  if (!cols.length) {
    console.error('No vendor config collection (usage page 0xFFFF / usage 0x02) found.');
    console.error('Is the keyboard connected? Close SharkDeck / ATK HUB / qmk.top first —');
    console.error('they hold the handle exclusively.');
    process.exit(1);
  }

  const results = [];
  for (const col of cols) {
    console.log(
      `\n=== ${col.vendorId.toString(16)}:${col.productId.toString(16)}  ${col.product ?? ''} ===`,
    );
    console.log(`    path ${col.path}`);
    const info = await identify(col);
    results.push(info);

    if (info.modelIdU32 == null) {
      console.log('    firmware did not answer GET_USB_VERSION (echo/none).');
      console.log('    Another app probably holds the channel.');
      continue;
    }
    console.log(
      `    model id   ${info.modelIdU32}  (u16 read: ${info.modelIdU16}${info.decodingsAgree ? ', agree' : ', DISAGREE — high bytes set'})`,
    );
    console.log(
      `    firmware   ${info.firmware ?? '?'}  (raw 0x${(info.firmwareRaw ?? 0).toString(16)})`,
    );
    if (info.reportRateHz) console.log(`    poll rate  ${info.reportRateHz} Hz`);
    if (info.keyMagnetismMode) console.log(`    HE preset  ${info.keyMagnetismMode}`);
    if (info.kbOption)
      console.log(
        `    kbOption   RTStab=${info.kbOption.rtStab} antiMistouch=${info.kbOption.antiMistouch} swapWASD=${info.kbOption.swapWasd}`,
      );

    if (!info.matches?.length) {
      console.log(`    !! model id ${info.modelIdU32} is in NEITHER registry.`);
      console.log('       Run `npm run extract:qmk` to refresh, or this is a board the');
      console.log('       vendor tools do not know either.');
    } else {
      for (const m of info.matches) {
        console.log(
          `    [${m.registry}] ${m.displayName ?? '?'}  ${m.name ?? ''}` +
            `  layout=${m.layoutName ?? m.keyLayout ?? '?'}  layers=${m.layer ?? '?'}` +
            `  magnetic=${m.magnetism ?? m.magnetic ?? '?'}`,
        );
      }
    }

    if (info.magnetism) {
      console.log(`    magnetism pages (travel multiplier ${info.travelMultiplier}):`);
      for (const [name, p] of Object.entries(info.magnetism)) {
        const vals = p.mm ? p.mm.join(', ') + ' mm' : p.distinct.join(', ');
        console.log(
          `      p${String(p.page).padStart(3)} ${name.padEnd(20)} ${p.width}B/key  ` +
            `${String(p.nonZero).padStart(3)}/${p.slots} set  [${vals}]`,
        );
      }
    }
  }

  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify({ capturedAt: new Date().toISOString(), devices: results }, null, 1),
    );
    console.log(`\nwrote ${OUT}`);
  }
  if (!WANT_PAGES) {
    console.log('\n(re-run with --pages to also dump the magnetic-switch state)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
