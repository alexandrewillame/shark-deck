/**
 * HARDWARE WRITE VERIFICATION for the per-key modes: snap-tap, toggle,
 * mod-tap, and DKS.
 *
 *   npm run snapshot:kb
 *   npm run verify:writes -- --go --interactive
 *       [--only snap,toggle,mt,dks] [--snapshot path/to/kb-snapshot.json]
 *
 * THIS WRITES TO THE KEYBOARD. It refuses to run without `--go` and a snapshot
 * to restore from. Without `--snapshot` it takes the newest one `snapshot:kb`
 * wrote, and only if that is under an hour old — restoring A and D from an
 * older one would undo whatever was set on them since. Close SharkDeck and
 * the vendor app before running it: two programs on one endpoint garble each
 * other's replies.
 *
 * Every step works on two keys, A and D, and goes:
 *   1. write the mode through the real driver method the app ships;
 *   2. read the magnetism pages back and check the bytes the firmware holds;
 *   3. with --interactive, ask you to try the key and say whether it behaved;
 *   4. RESTORE A and D from the snapshot, and verify the restore.
 *
 * The bytes prove the board stored the setting; only the key's behaviour
 * proves the firmware does what the setting says — which is what
 * --interactive is for, and what lifts a mode's Experimental tag in the
 * Actuation tab. Try the keys in a text editor, not in this terminal.
 *
 * The 2026-10-09 run settled two things this used to test: the snap-tap "who
 * wins" variants (mode values 8-10) are stored and ignored, so they are gone;
 * and a mod-tap key's HOLD is zone 0 and its TAP zone 1, which this now writes.
 *
 * Everything is paced — this firmware wedges its endpoint under back-to-back
 * feature reports, and a wrong-shaped frame hangs it outright. If it stops
 * answering, replug the keyboard; the snapshot is how to put A and D back.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import HID from 'node-hid';
import { HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { actionOfQuad } from '../src/shared/key-zones';
import type { MagneticKeySettings } from '../src/shared/types/keyboard-settings';

const PACE = 120;
const SETTLE = 35;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const STEPS = ['snap', 'toggle', 'mt', 'dks'] as const;
type Step = (typeof STEPS)[number];

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

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
};
const USAGE = [
  'Usage (from app/):',
  '  npm run snapshot:kb',
  '  npm run verify:writes -- --go --interactive',
  'Optional: --only snap,toggle,mt,dks   --snapshot path/to/kb-snapshot.json',
].join('\n');

/** Where `npm run snapshot:kb` writes (see scripts/kb-snapshot.ts). */
const SNAPSHOT_DIR = path.resolve('../docs/reverse-engineering');
/** How old a snapshot picked automatically may be. */
const SNAPSHOT_MAX_AGE_MIN = 60;

/**
 * The snapshot to restore from: the one named, or the newest `snapshot:kb`
 * wrote — if it is fresh. Named on the command line it is used as given.
 */
function pickSnapshot(): string {
  const named = arg('--snapshot');
  if (named) {
    if (!fs.existsSync(named)) {
      console.error(`No snapshot at ${named}.\n\n${USAGE}`);
      process.exit(1);
    }
    return named;
  }
  const newest = (fs.existsSync(SNAPSHOT_DIR) ? fs.readdirSync(SNAPSHOT_DIR) : [])
    .filter((f) => /^kb-snapshot-.*\.json$/.test(f))
    .map((f) => ({
      file: path.join(SNAPSHOT_DIR, f),
      at: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.at - a.at)[0];
  if (!newest) {
    console.error(`No snapshot yet — run \`npm run snapshot:kb\` first.\n\n${USAGE}`);
    process.exit(1);
  }
  const ageMin = (Date.now() - newest.at) / 60_000;
  if (ageMin > SNAPSHOT_MAX_AGE_MIN) {
    console.error(
      `The newest snapshot is ${Math.round(ageMin)} minutes old (${path.basename(newest.file)}). ` +
        'Run `npm run snapshot:kb` again, so A and D are restored to what they hold now.',
    );
    process.exit(1);
  }
  console.log(`restoring from ${path.basename(newest.file)} (${Math.round(ageMin)} min old)`);
  return newest.file;
}

if (!process.argv.includes('--go')) {
  console.error(`Refusing to write without --go.\n\n${USAGE}`);
  process.exit(1);
}
const snapshotPath = pickSnapshot();
const only = arg('--only')
  ?.split(',')
  .map((s) => s.trim()) ?? [...STEPS];
const unknown = only.filter((s) => !(STEPS as readonly string[]).includes(s));
if (unknown.length) {
  console.error(`Unknown step(s): ${unknown.join(', ')}. Steps: ${STEPS.join(', ')}`);
  process.exit(1);
}
const steps = STEPS.filter((s) => only.includes(s));
const interactive = process.argv.includes('--interactive');
const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));

/** Decode a snapshot page into per-slot values of the given byte width. */
function snapPage(page: number, width: number): number[] {
  const chunks: string[] = snapshot.rawPages?.[`page_${page}`] ?? [];
  const bytes: number[] = [];
  for (const c of chunks) {
    if (c === 'ECHO') continue;
    bytes.push(...c.split(' ').map((h: string) => parseInt(h, 16)));
  }
  const out: number[] = [];
  for (let i = 0; i + width <= bytes.length; i += width) {
    let v = 0;
    for (let b = 0; b < width; b++) v |= bytes[i + b]! << (8 * b);
    out.push(v >>> 0);
  }
  return out;
}

/** Little-endian bytes of `value`, `width` wide. */
const le = (value: number, width: number) =>
  Array.from({ length: width }, (_, i) => (value >>> (8 * i)) & 0xff);

async function main() {
  const all = await HID.devicesAsync();
  const cand = all.find(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cand) {
    console.error('Keyboard not found. If it wedged, replug it.');
    process.exit(1);
  }

  const layout = ATTACK_SHARK_R85HE.spec.keyMatrix!.layout!;
  const keyA = layout.find((k) => k.label === 'A')!;
  const keyD = layout.find((k) => k.label === 'D')!;
  const slotA = keyA.slot!;
  const slotD = keyD.slot!;
  const refA = { row: keyA.row, col: keyA.col };
  const refD = { row: keyD.row, col: keyD.col };
  console.log(`targets: A=slot ${slotA}  D=slot ${slotD}   steps: ${steps.join(', ')}`);

  // The baseline restored after every step — straight from the snapshot taken
  // before any of this, never from a read made while steps are running.
  const base = {
    p4: snapPage(4, 2),
    p5: snapPage(5, 1),
    p7: snapPage(7, 1),
    p9: snapPage(9, 1),
  };
  console.log(
    `snapshot baseline: p7[A]=${base.p7[slotA]} p7[D]=${base.p7[slotD]} ` +
      `p9[A]=${base.p9[slotA]} p9[D]=${base.p9[slotD]} p5[A]=${base.p5[slotA]} p4[A]=${base.p4[slotA]}`,
  );
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const dev = await HID.HIDAsync.open(cand.path!);
  const readPage = async (page: number, chunks: number, width: number) => {
    const bytes: number[] = [];
    for (let c = 0; c < chunks; c++) {
      const qf = feaFrame(229, [page, 1, c]);
      await dev.sendFeatureReport(qf);
      await sleep(SETTLE);
      const r = Array.from(await dev.getFeatureReport(0x00, 65));
      await sleep(PACE);
      if (r.length === qf.length && r.every((b, i) => b === qf[i])) continue; // echo
      bytes.push(...r.slice(1));
    }
    const out: number[] = [];
    for (let i = 0; i + width <= bytes.length; i += width) {
      let v = 0;
      for (let b = 0; b < width; b++) v |= bytes[i + b]! << (8 * b);
      out.push(v >>> 0);
    }
    return out;
  };
  /** single-key SET_MULTI_MAGNETISM, used only for the restore */
  const writeSlot = async (page: number, slot: number, bytes: number[], commit: boolean) => {
    await dev.sendFeatureReport(feaFrame(101, [page, 0, slot, commit ? 1 : 0, 0, 0, ...bytes]));
    await sleep(PACE);
  };

  /** Run `fn` with the shipped driver on its own channel, closed afterwards so
   *  the raw reads below have the endpoint to themselves. */
  const withDriver = async <T>(fn: (drv: CompxHeKeyboard) => Promise<T>): Promise<T> => {
    const ch = new HidChannel(
      cand as never,
      undefined,
      ATTACK_SHARK_R85HE.transport,
      ATTACK_SHARK_R85HE.checksum,
    );
    const kept = new Map<string, unknown>();
    const drv = new CompxHeKeyboard({
      descriptor: ATTACK_SHARK_R85HE,
      channel: ch,
      onWarning: (m: string) => console.log('  warn:', m),
      // What the app keeps per model; here only for this run.
      state: {
        get: async (k: string) => kept.get(k),
        set: async (k: string, v: unknown) => void kept.set(k, v),
      },
    });
    try {
      return await fn(drv);
    } finally {
      await ch.close();
      await sleep(PACE * 2);
    }
  };

  /** The keys as the board holds them now, through the driver. */
  const current = () =>
    withDriver(async (drv) => {
      const keys = await drv.readMagnetic();
      const find = (r: { row: number; col: number }) =>
        keys.find((k) => k.row === r.row && k.col === r.col)!;
      return { a: find(refA), d: find(refD) };
    });

  /** Ask whether the key behaved; `null` when not interactive. */
  const ask = async (what: string): Promise<boolean | null> => {
    if (!rl) return null;
    console.log(`  TRY IT, in a text editor: ${what}`);
    const answer = (await rl.question('  Did it? [y/n] ')).trim().toLowerCase();
    return answer.startsWith('y');
  };

  /** Put A and D back exactly as the snapshot had them, and check it. */
  const restore = async (zones: boolean) => {
    if (zones) {
      // Zones 1-3 of A hold nothing on a key that was never mod-tap or DKS —
      // which the snapshot's mode byte for A says it was not, or this would
      // have refused to start (see main's guard). Zone 0 gets A's own binding
      // back: a mod-tap step wrote its hold there.
      await withDriver((drv) => drv.setKeyZoneBindings(slotA, [null, '', '', '']));
      await withDriver((drv) => drv.setKeyRemap('base', slotA, tapA));
      await writeSlot(8, slotA, [0, 0, 0, 0], false);
    }
    await writeSlot(4, slotA, le(base.p4[slotA] ?? 0, 2), false);
    await writeSlot(5, slotA, [base.p5[slotA] ?? 0], false);
    await writeSlot(9, slotA, [base.p9[slotA] ?? 0xff], false);
    await writeSlot(9, slotD, [base.p9[slotD] ?? 0xff], false);
    await writeSlot(7, slotA, [base.p7[slotA] ?? 0], false);
    await writeSlot(7, slotD, [base.p7[slotD] ?? 0], true);
    const r7 = await readPage(7, 2, 1);
    const r9 = await readPage(9, 2, 1);
    const ok =
      r7[slotA] === (base.p7[slotA] ?? 0) &&
      r7[slotD] === (base.p7[slotD] ?? 0) &&
      r9[slotA] === (base.p9[slotA] ?? 0xff) &&
      r9[slotD] === (base.p9[slotD] ?? 0xff);
    console.log(
      `  restore: p7[A]=${r7[slotA]} p7[D]=${r7[slotD]} p9[A]=${r9[slotA]} p9[D]=${r9[slotD]} — ` +
        (ok ? 'back to the snapshot' : 'MISMATCH, put A and D back from the snapshot by hand'),
    );
    return ok;
  };

  // Zones 1-3 are only ever cleared, never restored, so a key that already
  // has mod-tap or DKS bindings must not be used: its bindings would be lost.
  const modeA = (base.p7[slotA] ?? 0) & 0x0f;
  if (modeA === 2 || modeA === 3) {
    console.error('A is set to DKS or mod-tap in the snapshot — set it to normal first.');
    process.exit(1);
  }
  // A's own binding: the TAP of the mod-tap step, and what its zone 0 goes
  // back to afterwards. Read from the board — A may be remapped.
  const ownA = await withDriver(async (drv) => {
    const raw = (await drv.readKeyBindings('base'))?.[slotA]?.raw;
    return raw ? actionOfQuad(raw) : null;
  });
  if (!ownA) {
    console.error("Could not read A's own binding — replug the keyboard and try again.");
    process.exit(1);
  }
  const tapA: string = ownA;
  console.log(`A's own binding: ${tapA}`);

  const results: Array<{
    step: string;
    bytes: boolean;
    behaved: boolean | null;
    restored: boolean;
  }> = [];
  const pair = (a: MagneticKeySettings, d: MagneticKeySettings): MagneticKeySettings[] => [
    { ...a, mode: 'snap', socdPartner: refD },
    { ...d, mode: 'snap', socdPartner: refA },
  ];

  try {
    for (const step of steps as Step[]) {
      console.log(`\n=== ${step} ===`);
      const { a, d } = await current();
      let bytes = false;
      let behaved: boolean | null = null;
      let zones = false;

      if (step === 'snap') {
        // A pairing is one batch carrying both keys — what the app sends.
        const w = await withDriver((drv) => drv.setMagneticKeys(pair(a, d)));
        console.log(`  setMagneticKeys -> ok=${w.ok} ${w.error ?? ''}`);
        const p7 = await readPage(7, 2, 1);
        const p9 = await readPage(9, 2, 1);
        const got = [p7[slotA]! & 0x0f, p7[slotD]! & 0x0f];
        console.log(
          `  page7: A=${got[0]} D=${got[1]} (want 7/7)   page9: A->${p9[slotA]} D->${p9[slotD]} (want ${slotD}/${slotA})`,
        );
        bytes = w.ok && got[0] === 7 && got[1] === 7 && p9[slotA] === slotD && p9[slotD] === slotA;
        behaved = await ask('hold A, then press D: only D types; let D go and A types again.');
      } else if (step === 'toggle') {
        const w = await withDriver((drv) => drv.setMagneticKey({ ...a, mode: 'tgl_hold' }));
        const p7 = await readPage(7, 2, 1);
        console.log(`  setMagneticKey -> ok=${w.ok}   page7: A=${p7[slotA]! & 0x0f} (want 4)`);
        bytes = w.ok && (p7[slotA]! & 0x0f) === 4;
        behaved = await ask('tap A once: it stays held down (a repeats); tap A again: it stops.');
      } else if (step === 'mt') {
        zones = true;
        // The hold in zone 0, Left Ctrl, and A's own binding — the tap — in
        // zone 1: the firmware fires zone 0 on a hold (the 2026-10-09 run, with
        // them the other way round, tapped Ctrl and held `a`). Bindings first,
        // the vendor's order.
        const z = await withDriver((drv) => drv.setKeyZoneBindings(slotA, ['e0', tapA]));
        const w = await withDriver((drv) =>
          drv.setMagneticKey({ ...a, mode: 'mt', mtHoldMs: 200 }),
        );
        const p7 = await readPage(7, 2, 1);
        const p5 = await readPage(5, 2, 1);
        console.log(
          `  bindings ok=${z.ok}  mode ok=${w.ok}   page7: A=${p7[slotA]! & 0x0f} (want 3)   page5: A=${p5[slotA]} (want 20)`,
        );
        bytes = z.ok && w.ok && (p7[slotA]! & 0x0f) === 3 && p5[slotA] === 20;
        behaved = await ask(
          'tap A: types a. Hold A for half a second, then press S: Ctrl+S (save).',
        );
      } else if (step === 'dks') {
        zones = true;
        // Actions 2-4 = B, C, D in zones 1-3; action 1 is A itself (zone 0).
        // One tap per point: `01 04 10 40`, the vendor's own capture.
        const z = await withDriver((drv) =>
          drv.setKeyZoneBindings(slotA, [null, '05', '06', '07']),
        );
        const w = await withDriver((drv) =>
          drv.setMagneticKey({
            ...a,
            mode: 'dks',
            dksPointMm: 0.7,
            dksZones: [
              { a: 'A', b: null, c: null, d: null },
              { a: null, b: 'B', c: null, d: null },
              { a: null, b: null, c: 'C', d: null },
              { a: null, b: null, c: null, d: 'D' },
            ],
          }),
        );
        const p7 = await readPage(7, 2, 1);
        const p4 = await readPage(4, 4, 2);
        // The read side is unconfirmed (see MM_PAGE.DKS_FLAGS_READ): shown,
        // not judged.
        const p10 = await readPage(10, 8, 4);
        console.log(
          `  bindings ok=${z.ok}  mode ok=${w.ok}   page7: A=${p7[slotA]! & 0x0f} (want 2)   page4: A=${p4[slotA]} (want 140)`,
        );
        console.log(
          `  page10 (read side, unconfirmed): A=${le(p10[slotA] ?? 0, 4)
            .map((x) => x.toString(16).padStart(2, '0'))
            .join(' ')} (01 04 10 40 if it mirrors page 8)`,
        );
        bytes = z.ok && w.ok && (p7[slotA]! & 0x0f) === 2 && p4[slotA] === 140;
        behaved = await ask(
          'press A slowly to the bottom, then let it up slowly: a (going down), b (bottom), c (coming up), d (released).',
        );
      }

      const restored = await restore(zones);
      results.push({ step, bytes, behaved, restored });
    }
  } finally {
    rl?.close();
    await dev.close();
  }

  console.log('\n=== summary ===');
  let failed = false;
  for (const r of results) {
    const behaved = r.behaved === null ? 'not tried' : r.behaved ? 'behaved' : 'DID NOT BEHAVE';
    console.log(
      `  ${r.step.padEnd(8)} bytes ${r.bytes ? 'OK' : 'FAILED'}   ${behaved}   restore ${r.restored ? 'OK' : 'MISMATCH'}`,
    );
    failed ||= !r.bytes || r.behaved === false || !r.restored;
  }
  console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  console.error('\nIf this failed with 0x79, replug the keyboard.');
  process.exit(1);
});
