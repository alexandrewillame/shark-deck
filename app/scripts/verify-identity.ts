/**
 * Hardware pass for device identification and the whole-board key list, on a
 * real ROYUAN keyboard (written for the R85HE, the one board with a verified
 * slot map to hold the rest against). Runs the app's own modules — registry,
 * identify driver, identity resolution, the real keyboard driver — not a
 * reimplementation.
 *
 *   npm run verify:identity                 # read-only
 *   npm run verify:identity -- --write      # + one key rewritten with its own values
 *
 * Read-only by default. Quit Shark Deck (and the vendor app) first: two
 * programs polling one board interleave their frames.
 *
 *  1. attaches as the app does: `resolveDescriptor` -> pending -> the identify
 *     driver's `0x8F` -> `resolveIdentity` -> the real driver;
 *  2. holds the "bound keymap slots are the keys" rule (CompxHeKeyboard
 *     `magneticKeys`, what a board without a slot map writes through) against
 *     the verified layout, by reading the board as if it had no layout;
 *  3. runs the attach-time layout agreement check (devices/layout-check.ts);
 *  4. takes a backup and checks it holds every block the backup policy
 *     requires — saved to `--out` (default: the OS temp dir), not to the
 *     app's backup store;
 *  5. with `--write` only: rewrites one key (A) with the values it already
 *     has, then re-reads every key and diffs against the snapshot — any key
 *     that moved is put back from it.
 *
 * Every frame goes to `<out>/frames.log`.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DeviceDescriptor } from '../src/shared/types/device';
import type { MagneticKeySettings } from '../src/shared/types/keyboard-settings';
import { ANSI_79_SG9047 } from '../src/shared/layouts';
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { resolveDescriptor } from '../src/main/devices/registry';
import { resolveIdentity } from '../src/main/devices/identity';
import { createDriver } from '../src/main/devices/drivers';
import type { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { layoutAgreement, layoutHolds } from '../src/main/devices/layout-check';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const OUT = args.includes('--out')
  ? args[args.indexOf('--out') + 1]!
  : join(tmpdir(), 'sharkdeck-verify');
mkdirSync(OUT, { recursive: true });
const FRAMES = join(OUT, 'frames.log');
writeFileSync(FRAMES, '');

const ok = (b: boolean) => (b ? 'PASS' : 'FAIL');
let failures = 0;
const check = (label: string, pass: boolean, detail = '') => {
  if (!pass) failures++;
  console.log(`${ok(pass)}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const slotOf = (k: { row: number; col: number }) => k.col * 6 + k.row;
const sameKey = (a: MagneticKeySettings, b: MagneticKeySettings) =>
  JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const cand = (await enumerate()).find(
    (c) =>
      (c.vendorId === 0x3151 || c.vendorId === 0x39ab) &&
      c.usagePage === 0xffff &&
      c.usage === 0x02,
  );
  if (!cand) {
    console.error('No ROYUAN keyboard configuration collection found. Is the board plugged in?');
    process.exit(2);
  }
  console.log(
    `device   ${cand.product ?? '?'}  ${cand.vendorId.toString(16)}:${cand.productId.toString(16)}`,
  );
  console.log(`frames   ${FRAMES}\n`);

  // 1 — attach as the app does
  const pending = resolveDescriptor(cand.vendorId, cand.productId)!;
  check(
    'attaches pending, identify driver only',
    pending.identity === 'pending' && pending.driver === 'royuan-identify',
  );
  const ch = new HidChannel(
    cand,
    (dir, _key, hex, note) => appendFileSync(FRAMES, `${dir} ${hex}${note ? `  # ${note}` : ''}\n`),
    pending.transport,
    pending.checksum,
    { requestPaceMs: 30 },
  );
  const identify = createDriver({
    descriptor: pending,
    channel: ch,
    onWarning: (m) => console.log('  warning:', m),
  });
  const key = await identify.identify();
  check('identify (0x8F) answers a model id', key?.family === 'royuan', JSON.stringify(key));
  if (!key) throw new Error('no identify answer — stopping before anything else is sent');
  const desc = resolveIdentity({ vid: cand.vendorId, pid: cand.productId }, key);
  check(
    'resolves to the R85HE descriptor',
    desc.model === 'attack-shark-r85he',
    `${desc.model} (${desc.identity ?? 'exact'})`,
  );
  const warn = (m: string) => console.log('  warning:', m);
  const drv = createDriver({ descriptor: desc, channel: ch, onWarning: warn }) as CompxHeKeyboard;
  console.log(`driver   ${desc.driver}\n`);

  // 2 — the bound-slot rule, read as if the board had no layout
  const layoutSlots = ANSI_79_SG9047.map((k) => k.slot!).sort((a, b) => a - b);
  const blind: DeviceDescriptor = {
    ...desc,
    spec: { ...desc.spec, keyMatrix: { ...desc.spec.keyMatrix!, layoutStatus: 'none' } },
  };
  const blindDrv = createDriver({
    descriptor: blind,
    channel: ch,
    onWarning: warn,
  }) as CompxHeKeyboard;
  const blindKeys = await blindDrv.readMagnetic();
  const bound = blindKeys.map(slotOf).sort((a, b) => a - b);
  const extra = bound.filter((s) => !layoutSlots.includes(s));
  const missing = layoutSlots.filter((s) => !bound.includes(s));
  check(
    "bound keymap slots are exactly the layout's keys",
    bound.length > 0 && !extra.length && !missing.length,
    `${bound.length} bound vs ${layoutSlots.length} in the layout` +
      (extra.length ? `; extra ${extra.join(',')}` : '') +
      (missing.length ? `; missing ${missing.join(',')}` : ''),
  );

  // 3 — the attach-time agreement check
  const base = await drv.readKeyBindings('base');
  const a = base ? layoutAgreement(ANSI_79_SG9047, base) : null;
  check(
    "the board's keymap bears its layout out (>= 90 %)",
    !!a && layoutHolds(a),
    a ? `${a.agree} of ${a.checked} keys` : 'keymap not read',
  );

  // 4 — a backup that holds what the policy requires
  const blocks = await drv.backup();
  const policy = drv.backupPolicy();
  const absent = policy.required.filter((b) => !(b in blocks));
  writeFileSync(join(OUT, 'backup.json'), JSON.stringify({ model: desc.model, blocks }, null, 2));
  check(
    `backup holds every required block (${policy.kind})`,
    absent.length === 0,
    absent.length
      ? `missing ${absent.join(', ')}`
      : `${Object.keys(blocks).length} blocks -> ${join(OUT, 'backup.json')}`,
  );

  // 5 — one key rewritten with its own values, everything re-read
  if (WRITE) {
    if (absent.length) throw new Error('no complete backup — refusing to write');
    const before = await drv.readMagnetic();
    const A = before.find((k) => slotOf(k) === 9);
    if (!A) throw new Error('key A (slot 9) not found');
    const w = await drv.setMagneticKey(A);
    check(
      'no-change write to key A accepted',
      w.ok,
      `${w.verified}, ${(w.frames ?? []).length} frames`,
    );
    await new Promise((r) => setTimeout(r, 300));
    const after = await drv.readMagnetic();
    const moved = before.filter((k) => {
      const now = after.find((x) => x.row === k.row && x.col === k.col);
      return !now || !sameKey(k, now);
    });
    check(
      'no key changed',
      moved.length === 0,
      moved.length ? `moved: ${moved.map(slotOf).join(',')}` : `${after.length} keys identical`,
    );
    if (moved.length) {
      const r = await drv.setMagneticKeys(moved);
      console.log(`  put back from the snapshot: ok=${r.ok}`);
    }
  } else {
    console.log('SKIP  no-change write (run with --write)');
  }

  await ch.close();
  console.log(`\n${failures ? `${failures} check(s) failed` : 'all checks passed'}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error('ERROR', e);
  process.exit(2);
});
