/**
 * Which settings does an onboard profile actually hold?
 *
 *   npm run probe:profiles             # read-only sweep (default)
 *   npm run probe:profiles -- --write  # definitive, mutating; see below
 *
 * WHY THIS EXISTS
 *
 * SharkDeck shows an "Onboard profile" picker above nearly every tab, which
 * claims those tabs are scoped to the selected slot. Some are not.
 * `docs/protocol/keyboard-compx.md` ("Profiles and what is slot-scoped")
 * records what the frames show — the key matrix and the Fn layer carry a
 * profile byte, `SET_LEDPARAM` / `SET_SLEDPARAM` / `SET_USERPIC` carry none —
 * but it also says plainly that what the firmware stores per slot is
 * unconfirmed and not observable from the frames. Only the board can answer.
 *
 * WHAT EACH MODE PROVES
 *
 *   --read (default)
 *     Selects each slot in turn and dumps the same set of GETs, then reports
 *     which fields came back DIFFERENT across slots. A field that differs is
 *     slot-scoped, conclusively. A field that matches everywhere proves
 *     nothing on its own — the slots may simply be configured alike — so those
 *     are reported as "same (inconclusive)", never as "global".
 *
 *   --write
 *     Settles the inconclusive ones. Writes a distinct value to each slot,
 *     returns to slot 1 and reads back: slot 1's own value means the board
 *     keeps that setting per slot; the last value written means one shared
 *     register. Snapshots every field it will touch first and puts it back.
 *
 * THE ONLY WRITE IN --read MODE IS `SET_PROFILE` ITSELF, which is the command
 * the profile dropdown already sends, and the slot that was active on entry is
 * restored before exit. No setting is written.
 *
 * FIRMWARE HAZARDS — both learned the hard way on a real R85HE, and the reason
 * this script is paced and hand-rolls nothing new (see scripts/kb-snapshot.ts):
 *
 *  1. Bursty feature-report I/O wedges the vendor endpoint (Windows error
 *     0x79) until the keyboard is replugged. Hence PACE/SETTLE below, and no
 *     retries anywhere.
 *  2. A GET sent with the wrong ARGUMENT SHAPE hangs the MCU outright. Every
 *     frame here is one kb-snapshot.ts already exercises on this board.
 */
import fs from 'node:fs';
import path from 'node:path';
import HID from 'node-hid';

const PACE = 120;
const SETTLE = 35;
/** After SET_PROFILE, before reading — the board swaps its active block. */
const SWITCH_SETTLE = 400;

const SLOTS = 4;
const WRITE_MODE = process.argv.includes('--write');

/** compx-fea frame (checksum at byte 8; byte 9 for cmds 7/8) — as kb-snapshot.ts. */
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

const SET_PROFILE = 4;
const GET_PROFILE = 132;
const SET_REPORT = 3;

/**
 * What to compare, grouped by the tab whose profile badge depends on the
 * answer. Argument-free GETs only.
 */
const FIELDS: Array<[tab: string, name: string, cmd: number]> = [
  ['Profile', 'GET_REPORT (poll rate)', 131],
  ['Profile', 'GET_DEBOUNCE', 134],
  ['Profile', 'GET_SLEEPTIME', 145],
  ['Keys', 'GET_KBOPTION (Fn/WASD/...)', 137],
  ['Lighting', 'GET_LEDPARAM (per-key effect)', 135],
  ['Lighting', 'GET_SLEDPARAM (side light)', 136],
];

/** Magnetism pages — the Actuation tab. `chunks / 2` = bytes per key. */
const MM_PAGES: Array<[label: string, page: number, chunks: number]> = [
  ['Actuation: travel (press)', 0, 4],
  ['Actuation: release', 1, 4],
  ['Actuation: RT press', 2, 4],
  ['Actuation: modes', 7, 2],
  ['Actuation: switch type', 252, 2],
];

type Reading = Record<string, string>;
const out: {
  capturedAt: string;
  mode: string;
  entrySlot: number | null;
  bySlot: Record<number, Reading>;
  verdicts?: Record<string, string>;
  writeProbe?: Record<string, string>;
} = {
  capturedAt: new Date().toISOString(),
  mode: WRITE_MODE ? 'write' : 'read',
  entrySlot: null,
  bySlot: {},
};

const OUT = path.resolve(
  `../docs/reverse-engineering/profile-scope-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);
const persist = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
};

async function main() {
  const all = await HID.devicesAsync();
  const cand = all.find(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cand) {
    console.error('No Compx vendor collection found. If it just wedged, replug the keyboard.');
    process.exit(1);
  }

  const dev = await HID.HIDAsync.open(cand.path!);
  const q = async (cmd: number, args: number[] = []) => {
    const query = feaFrame(cmd, args);
    await dev.sendFeatureReport(query);
    await sleep(SETTLE);
    const r = Array.from(await dev.getFeatureReport(0x00, 65));
    await sleep(PACE);
    return { bytes: r, echo: r.length === query.length && r.every((b, i) => b === query[i]) };
  };
  const read = async (cmd: number, args: number[] = []) => {
    const r = await q(cmd, args);
    // Byte 0 is the report id and byte 1 echoes the command; neither varies
    // with the slot, so they are dropped rather than masking a difference.
    return r.echo ? 'ECHO' : hex(r.bytes.slice(2));
  };
  const selectSlot = async (slot: number) => {
    await dev.sendFeatureReport(feaFrame(SET_PROFILE, [slot - 1]));
    await sleep(SWITCH_SETTLE);
    const back = await q(GET_PROFILE);
    return (back.bytes[2] ?? 0) + 1;
  };

  try {
    console.log(
      `device  ${cand.product}  ${cand.vendorId.toString(16)}:${cand.productId.toString(16)}`,
    );
    const entry = await q(GET_PROFILE);
    out.entrySlot = (entry.bytes[2] ?? 0) + 1;
    console.log(`active slot on entry: ${out.entrySlot}\n`);

    for (let slot = 1; slot <= SLOTS; slot++) {
      const landed = await selectSlot(slot);
      if (landed !== slot) console.log(`  ! asked for slot ${slot}, board reports ${landed}`);
      const r: Reading = {};
      for (const [, name, cmd] of FIELDS) r[name] = await read(cmd);
      for (const [label, page, chunks] of MM_PAGES) {
        const parts: string[] = [];
        for (let c = 0; c < chunks; c++) parts.push(await read(229, [page, 1, c]));
        r[label] = parts.join('|');
      }
      out.bySlot[slot] = r;
      persist();
      console.log(`  slot ${slot}: ${Object.keys(r).length} fields read`);
    }

    // ---- --write: settle the inconclusive ones --------------------------
    //
    // Only the polling rate is probed this way. It is the setting the app used
    // to shadow per slot, it is a single byte with a matching GET, and a wrong
    // value is harmless and restored below. The magnetism pages are NOT probed
    // this way: writing them means 128 paced transactions per slot, which is
    // exactly the burst that wedges this endpoint.
    if (WRITE_MODE) {
      console.log('\n--write: probing GET_REPORT (poll rate) for real slot scoping');
      const before: number[] = [];
      for (let slot = 1; slot <= SLOTS; slot++) {
        await selectSlot(slot);
        before.push((await q(131)).bytes[2] ?? 0);
      }
      // A different index per slot, from the low end of the table so any board
      // accepts them.
      for (let slot = 1; slot <= SLOTS; slot++) {
        await selectSlot(slot);
        await dev.sendFeatureReport(feaFrame(SET_REPORT, [0x00, slot - 1]));
        await sleep(PACE);
      }
      await selectSlot(1);
      const back = (await q(131)).bytes[2] ?? 0;
      out.writeProbe = {
        'GET_REPORT (poll rate)':
          back === 0
            ? 'PER-SLOT — slot 1 kept its own value after the others were written'
            : `GLOBAL — slot 1 reads ${back}, the value last written (slot ${back + 1})`,
      };
      console.log(`  ${out.writeProbe['GET_REPORT (poll rate)']}`);
      for (let slot = 1; slot <= SLOTS; slot++) {
        await selectSlot(slot);
        await dev.sendFeatureReport(feaFrame(SET_REPORT, [0x00, before[slot - 1]!]));
        await sleep(PACE);
      }
      console.log('  restored the original polling rates');
      persist();
    }

    if (out.entrySlot) await selectSlot(out.entrySlot);
    console.log(`\nrestored slot ${out.entrySlot}\n`);
  } finally {
    await dev.close();
  }

  // ---- verdicts ---------------------------------------------------------
  const names = Object.keys(out.bySlot[1] ?? {});
  const tabOf = new Map<string, string>([
    ...FIELDS.map(([tab, name]) => [name, tab] as [string, string]),
    ...MM_PAGES.map(([label]) => [label, 'Actuation'] as [string, string]),
  ]);
  const verdicts: Record<string, string> = {};
  const byTab = new Map<string, { differs: number; total: number }>();

  console.log('field                                     tab        verdict');
  console.log('-'.repeat(78));
  for (const name of names) {
    const vals = Object.values(out.bySlot).map((r) => r[name]);
    const differs = new Set(vals).size > 1;
    const allEcho = vals.every((v) => v === 'ECHO');
    const verdict = allEcho
      ? 'NO REPLY (firmware does not answer this GET)'
      : differs
        ? 'PER-SLOT  (values differ across slots)'
        : 'same (inconclusive - slots may just match)';
    verdicts[name] = verdict;
    const tab = tabOf.get(name) ?? '?';
    if (!allEcho) {
      const s = byTab.get(tab) ?? { differs: 0, total: 0 };
      s.total++;
      if (differs) s.differs++;
      byTab.set(tab, s);
    }
    console.log(`${name.padEnd(41)} ${tab.padEnd(10)} ${verdict}`);
  }
  out.verdicts = verdicts;
  persist();

  console.log('\nBy tab - this is what the profile badge should follow:');
  for (const [tab, s] of byTab)
    console.log(
      `  ${tab.padEnd(10)} ${s.differs}/${s.total} fields differ  ->  ` +
        (s.differs > 0 ? 'SCOPED (keep the badge)' : 'no evidence of scoping'),
    );

  const inconclusive = names.filter((n) => verdicts[n]!.startsWith('same'));
  if (inconclusive.length && !WRITE_MODE) {
    console.log(
      `\n${inconclusive.length} field(s) read the same on every slot. That is NOT proof they are` +
        '\nglobal - the slots may simply be configured alike. Set two slots up' +
        '\ndifferently in the app and re-run, or pass --write to settle it outright.',
    );
  }
  console.log(`\nwrote ${OUT}`);
}

main().catch((e) => {
  persist();
  console.error(e);
  console.error(`\nPartial result saved to ${OUT}`);
  console.error('If this failed with 0x79, the endpoint is wedged - replug the keyboard.');
  process.exit(1);
});
