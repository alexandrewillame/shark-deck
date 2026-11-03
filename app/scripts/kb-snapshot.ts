/**
 * Full read-only snapshot of a connected Compx/ROYUAN keyboard, so a hardware
 * experiment can be undone.
 *
 *   npm run snapshot:kb                 # -> docs/reverse-engineering/kb-snapshot-<ts>.json
 *   npm run snapshot:kb -- --out p.json
 *
 * DESIGN NOTES — both learned the hard way on a real R85HE:
 *
 * 1. This firmware wedges its vendor endpoint under bursty feature-report I/O
 *    (Windows error 0x79), and only a replug clears it. So: one paced loop, no
 *    retries, ~120 ms between transactions.
 *
 * 2. A GET sent with the WRONG ARGUMENT SHAPE hangs the MCU outright — this is
 *    not a burst effect. `GET_FN` (0x90) takes three args `[0, 0xff, chunk]`;
 *    sending a fourth wedged the board instantly, after 70 paced transactions
 *    had just succeeded. Never hand-roll a frame here. Anything whose exact
 *    shape is not verified goes through the driver, which is what the app
 *    itself ships.
 *
 * 3. The snapshot is written to disk after EVERY section. An earlier version
 *    built the whole object and wrote at the end, so the wedge in (2) threw
 *    away a complete magnetism capture.
 *
 * READ-ONLY. Every command sent is a GET.
 */
import fs from 'node:fs';
import path from 'node:path';
import HID from 'node-hid';
import { HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';

const PACE = 120;
const SETTLE = 35;

/** compx-fea GET frame (checksum at byte 8) — mirrors scripts/lib/compx-fea.mjs. */
function feaFrame(cmd: number, args: number[] = []): number[] {
  const k = cmd === 0x07 || cmd === 0x08 ? 9 : 8;
  const f = new Array(65).fill(0);
  f[1] = cmd;
  args.forEach((a, i) => {
    const at = 2 + i < k ? 2 + i : 2 + i + 1;
    f[at] = a & 0xff;
  });
  let sum = 0;
  for (let i = 1; i < k; i++) sum = (sum + f[i]) & 0xff;
  f[k] = (0xff - sum) & 0xff;
  return f;
}
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * page -> vendor chunk count. `chunks / 2` = bytes per key over 128 slots.
 * Page 16 is omitted: it echoes on this firmware (not implemented), and every
 * needless transaction is wedge risk.
 */
const PAGES: Array<[page: number, chunks: number]> = [
  [0, 4],
  [1, 4],
  [2, 4],
  [3, 4],
  [4, 4],
  [5, 2],
  [6, 4],
  [7, 2],
  [8, 8],
  [9, 2],
  [251, 2],
  [252, 2],
];

/** Argument-free GETs. Bare frames — verified answering on this board. */
const SIMPLE_GETS: Array<[name: string, cmd: number]> = [
  ['GET_USB_VERSION', 0x8f],
  ['GET_REPORT', 0x83],
  ['GET_PROFILE', 0x84],
  ['GET_DEBOUNCE', 0x86],
  ['GET_LEDPARAM', 0x87],
  ['GET_SLEDPARAM', 0x88],
  ['GET_KBOPTION', 0x89],
  ['GET_SLEEPTIME', 0x91],
];

const outArg = process.argv.indexOf('--out');
const OUT = path.resolve(
  outArg > -1
    ? process.argv[outArg + 1]!
    : `../docs/reverse-engineering/kb-snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);

const snap: Record<string, unknown> = {
  capturedAt: new Date().toISOString(),
  complete: false,
  note: 'Raw GET replies. Magnetism pages are 64 data bytes per chunk from frame[1].',
};

function persist() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(snap, null, 1));
}

async function main() {
  const all = await HID.devicesAsync();
  const cand = all.find(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cand) {
    console.error('No Compx vendor collection found. If it just wedged, replug the keyboard.');
    process.exit(1);
  }

  // --- phase 1: raw reads we have verified the frame shape for -------------
  const dev = await HID.HIDAsync.open(cand.path!);
  const q = async (cmd: number, args: number[] = []) => {
    const query = feaFrame(cmd, args);
    await dev.sendFeatureReport(query);
    await sleep(SETTLE);
    const r = Array.from(await dev.getFeatureReport(0x00, 65));
    await sleep(PACE);
    return { bytes: r, echo: r.length === query.length && r.every((b, i) => b === query[i]) };
  };

  try {
    console.log(
      `device  ${cand.product}  ${cand.vendorId.toString(16)}:${cand.productId.toString(16)}`,
    );

    const ver = await q(0x8f);
    const modelId = ver.bytes[2]! | (ver.bytes[3]! << 8);
    const fwRaw = ver.bytes[8]! | (ver.bytes[9]! << 8);
    snap.device = {
      product: cand.product,
      vid: cand.vendorId,
      pid: cand.productId,
      serial: cand.serialNumber ?? null,
      modelId,
      firmwareRaw: fwRaw,
      travelMultiplier: fwRaw < 768 ? 10 : fwRaw < 1280 ? 100 : 200,
    };
    persist();
    console.log(`  modelId ${modelId}  fwRaw 0x${fwRaw.toString(16)}`);

    const gets: Record<string, string> = {};
    for (const [name, cmd] of SIMPLE_GETS) {
      const r = await q(cmd);
      gets[name] = r.echo ? 'ECHO' : hex(r.bytes);
    }
    snap.simpleGets = gets;
    persist();
    console.log(
      `  simple GETs: ${Object.values(gets).filter((v) => v !== 'ECHO').length}/${SIMPLE_GETS.length}`,
    );

    const raw: Record<string, string[]> = {};
    for (const [page, chunks] of PAGES) {
      const out: string[] = [];
      for (let c = 0; c < chunks; c++) {
        const r = await q(229, [page, 1, c]);
        out.push(r.echo ? 'ECHO' : hex(r.bytes.slice(1)));
      }
      raw[`page_${page}`] = out;
      snap.rawPages = raw;
      persist(); // after every page, not every run
      console.log(
        `    page ${String(page).padStart(3)}  ${out.filter((x) => x !== 'ECHO').length}/${chunks} chunks`,
      );
    }
  } finally {
    await dev.close();
  }

  // --- phase 2 (opt-in): driver-built reads -----------------------------
  // These go through `request()`, which RETRIES internally — a burst risk on
  // this firmware. Only needed to restore key remaps / lighting; the magnetism
  // pages above are enough to undo any magnetic-page experiment. Off by
  // default: pass --driver-reads when you actually need them.
  if (!process.argv.includes('--driver-reads')) {
    snap.complete = true;
    snap.note2 = 'phase 2 (key remaps, lighting) skipped — pass --driver-reads to include';
    persist();
    console.log(`
wrote ${OUT}  (magnetism + simple GETs only)`);
    return;
  }
  const d = ATTACK_SHARK_R85HE;
  const ch = new HidChannel(cand as never, undefined, d.transport, d.checksum);
  const drv = new CompxHeKeyboard({
    descriptor: d,
    channel: ch,
    onWarning: () => {},
    state: {},
  } as never);
  try {
    for (const [label, fn] of [
      ['keyBindingsBase', () => drv.readKeyBindings('base')],
      ['keyBindingsFn', () => drv.readKeyBindings('fn')],
      ['perKeyLighting', () => drv.readPerKeyLighting()],
      ['lighting', () => drv.readLighting()],
      ['sideLighting', () => drv.readSideLighting()],
    ] as Array<[string, () => Promise<unknown>]>) {
      await sleep(PACE * 2);
      const v = await fn().catch((e) => ({ error: String((e as Error).message ?? e) }));
      (snap as Record<string, unknown>)[label] = v;
      persist();
      const n = Array.isArray(v) ? `${v.length} entries` : v == null ? 'NULL' : 'ok';
      console.log(`    ${label.padEnd(16)} ${n}`);
    }
  } finally {
    await ch.close();
  }

  snap.complete = true;
  persist();
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => {
  persist(); // keep whatever we got
  console.error(e);
  console.error(`\nPartial snapshot saved to ${OUT}`);
  console.error('If this failed with 0x79, the endpoint is wedged — replug the keyboard.');
  process.exit(1);
});
