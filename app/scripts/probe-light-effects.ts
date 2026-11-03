/**
 * Which whole-board lighting effects does this keyboard actually implement?
 *
 *   npm run probe:effects            # sweep every index, read each back
 *   npm run probe:effects -- --hold  # 2.5s per effect, so you can watch it
 *
 * **THIS SCRIPT WRITES TO THE DEVICE.** It sends `SET_LEDPARAM` once per
 * effect index — the same command the Lighting tab's Apply button sends — and
 * puts the board back to whatever it held on entry before it exits. There is
 * no read-only mode, because the question is what the board DOES with a write.
 *
 * WHY THIS EXISTS
 *
 * Three effects reported as "the keyboard goes black when I apply them":
 * Circle Wave, Dazzling and Rain Down — wire indices 15, 16 and 17 by
 * `KB_LIGHT_EFFECTS_TABLE`, which is three CONSECUTIVE entries. Neighbours on
 * either side work. Changing colour and colour-mode changes nothing.
 *
 * Three explanations fit that shape and this tells them apart:
 *
 *  1. The index is wrong. `KB_LIGHT_EFFECTS_TABLE` is the vendor's `LIGHT_LIST`
 *     and the bundle carries FIVE variants of that list — three ending at 25,
 *     one at 24, one mapping `LightUserColor` to 66 (see shared/lighting.ts).
 *     If this generation's list is not the one we picked, a run of entries
 *     lands on the wrong effect or on nothing. The read-back is the tell:
 *     a board that answers with a DIFFERENT index than it was sent has
 *     remapped or rejected it.
 *  2. The index is right and the firmware clamps it. Same tell.
 *  3. The index is right, the board accepts it, and it renders dark with these
 *     parameters — in which case the read-back matches and only your eyes can
 *     say. That is what `--hold` is for.
 *
 * FIRMWARE HAZARDS, both learned on a real R85HE (see probe-profile-scope.ts):
 * bursty feature-report I/O wedges the vendor endpoint until the keyboard is
 * replugged, and a GET with the wrong argument shape hangs the MCU. Hence the
 * pacing below, no retries, and nothing sent that the app does not already
 * send.
 */
import fs from 'node:fs';
import path from 'node:path';
import HID from 'node-hid';
import { KB_LIGHT_EFFECTS_TABLE } from '../src/shared/lighting';

const PACE = 140;
const SETTLE = 40;
/** The board applies a lighting write asynchronously; an immediate GET can
 *  still answer with the previous effect. `compx-keyboard.ts` uses the same
 *  idea for its own read-back (`settleMs`). */
const APPLY_SETTLE = 260;
const HOLD = process.argv.includes('--hold') ? 2500 : 0;

const SET_LEDPARAM = 7;
const GET_LEDPARAM = 135;

/** compx-fea frame (checksum at byte 8; byte 9 for cmds 7/8). */
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
 * Where a reply's payload starts — the firmware sometimes overwrites the
 * echoed checksum at byte 2 with real data and sometimes does not. Same rule
 * as `feaPayloadStart` in compx-keyboard.ts.
 */
function payloadStart(reply: number[], command: number): 2 | 3 {
  return reply[2] === ((0xff - command) & 0xff) ? 3 : 2;
}

type Row = {
  index: number;
  id: string;
  label: string;
  listed: boolean;
  sent: number[];
  reply: string;
  readEffect: number | null;
  readSpeed: number | null;
  readBright: number | null;
  readOption: number | null;
  readRgb: string | null;
  verdict: string;
};

const out: {
  capturedAt: string;
  entry: string | null;
  rows: Row[];
  summary: string[];
} = { capturedAt: new Date().toISOString(), entry: null, rows: [], summary: [] };

const OUT = path.resolve(
  `../docs/reverse-engineering/light-effects-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);

async function main() {
  const all = await HID.devicesAsync();
  const cand = all.find(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cand) {
    console.error('No Compx vendor collection found. If it just wedged, replug the keyboard.');
    process.exit(1);
  }
  console.log(`device: ${cand.product ?? '?'}  vid=3151 pid=${cand.productId?.toString(16)}`);

  const dev = await HID.HIDAsync.open(cand.path!);
  const get = async (cmd: number) => {
    await dev.sendFeatureReport(feaFrame(cmd));
    await sleep(SETTLE);
    const r = Array.from(await dev.getFeatureReport(0x00, 65));
    await sleep(PACE);
    return r;
  };
  const set = async (cmd: number, args: number[]) => {
    await dev.sendFeatureReport(feaFrame(cmd, args));
    await sleep(PACE);
  };

  // ---- what the board is holding right now, so it can be put back ---------
  const entry = await get(GET_LEDPARAM);
  const eo = payloadStart(entry, GET_LEDPARAM);
  const restore = [
    entry[eo] ?? 1,
    entry[eo + 1] ?? 2,
    entry[eo + 2] ?? 4,
    entry[eo + 3] ?? 7,
    entry[eo + 4] ?? 0,
    entry[eo + 5] ?? 200,
    entry[eo + 6] ?? 200,
  ];
  out.entry = hex(entry.slice(0, 12));
  console.log(`on entry: ${out.entry}   (payload at byte ${eo})`);
  console.log(
    `          effect=${restore[0]} speed=${restore[1]} bright=${restore[2]} option=0x${restore[3]!.toString(16)} rgb=${restore.slice(4).join(',')}`,
  );
  console.log('');

  // Fixed, unambiguous parameters: mid speed, FULL brightness, custom-colour
  // nibble, pure red. Nothing here can make a working effect look dark.
  const SPEED = 2;
  const BRIGHT = 4;
  const OPTION = 0x07;
  const RGB = [255, 0, 0];

  const LAST = KB_LIGHT_EFFECTS_TABLE.length - 1;
  for (let index = 1; index <= LAST; index++) {
    const e = KB_LIGHT_EFFECTS_TABLE[index]!;
    const args = [index, SPEED, BRIGHT, OPTION, ...RGB];
    await set(SET_LEDPARAM, args);
    await sleep(APPLY_SETTLE);
    const r = await get(GET_LEDPARAM);
    const o = payloadStart(r, GET_LEDPARAM);
    const readEffect = r[o] ?? null;
    const row: Row = {
      index,
      id: e.id,
      label: e.label,
      listed: !!e.listed,
      sent: args,
      reply: hex(r.slice(0, 12)),
      readEffect,
      readSpeed: r[o + 1] ?? null,
      readBright: r[o + 2] ?? null,
      readOption: r[o + 3] ?? null,
      readRgb: [r[o + 4], r[o + 5], r[o + 6]].join(','),
      verdict:
        readEffect === index
          ? 'accepted'
          : readEffect === 0
            ? 'REJECTED -> off'
            : `REMAPPED -> ${readEffect} (${KB_LIGHT_EFFECTS_TABLE[readEffect ?? 0]?.id ?? '?'})`,
    };
    out.rows.push(row);
    console.log(
      `${String(index).padStart(2)} ${e.label.padEnd(20)} ${e.listed ? ' ' : '·'} ` +
        `back: eff=${String(readEffect).padStart(2)} sp=${row.readSpeed} br=${row.readBright} ` +
        `opt=0x${(row.readOption ?? 0).toString(16).padStart(2, '0')} rgb=${row.readRgb}  ${row.verdict}`,
    );
    if (HOLD) await sleep(HOLD);
  }

  // ---- put it back --------------------------------------------------------
  console.log('');
  await set(SET_LEDPARAM, restore);
  await sleep(APPLY_SETTLE);
  const back = await get(GET_LEDPARAM);
  console.log(`restored: ${hex(back.slice(0, 12))}`);

  const bad = out.rows.filter((r) => r.verdict !== 'accepted');
  out.summary =
    bad.length === 0
      ? [
          'Every index was accepted and read back unchanged. The wire table matches this',
          'generation, so any effect that looks dark is the firmware rendering it dark with',
          'these parameters — re-run with --hold and watch which ones.',
        ]
      : bad.map((r) => `${r.index} ${r.id}: ${r.verdict}`);
  console.log('');
  for (const line of out.summary) console.log(line);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`\nwrote ${OUT}`);
  await dev.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
