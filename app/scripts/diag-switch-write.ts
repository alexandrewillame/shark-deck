/**
 * Time how long magnetism page 252 takes to reflect a write.
 *
 *   npx vite-node --config vitest.config.ts scripts/diag-switch-write.ts
 *
 * **WRITES TO THE DEVICE.** It changes one key's switch id, samples the page
 * until it agrees, and then puts the original value back — so the board is left
 * exactly as it was found. Run it with nothing else holding the handle.
 *
 * Why it exists: `setSwitchTypes` wrote and then read back immediately, got the
 * pre-write page, and reported `mismatch`. That was read as "this firmware does
 * not store switch assignments", the Switches view latched it and disabled
 * itself — and the assignments had in fact landed, so the user could see keys
 * they had changed and had no way to change them back. The page is not the
 * problem; the timing of the check is.
 */
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';

/** A key well away from anything the user is likely to be watching. */
const PROBE_SLOT = 39; // H

async function main() {
  const cands = (await enumerate()).filter(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cands.length) {
    console.error('No Compx vendor collection found — is the keyboard connected?');
    process.exit(1);
  }
  const d = ATTACK_SHARK_R85HE;
  const ch = new HidChannel(cands[0]!, undefined, d.transport, d.checksum, { opTimeoutMs: 2500 });
  const drv = new CompxHeKeyboard({
    descriptor: d,
    channel: ch,
    onWarning: (m: string) => console.log('  warning:', m),
    state: {},
  } as never);

  const read = async () => (await drv.readSwitchTypes())?.[PROBE_SLOT];
  const original = await read();
  if (original === undefined) {
    console.error('could not read the page — aborting without writing anything');
    process.exit(1);
  }
  const probe = original === 2 ? 3 : 2;
  console.log(`slot ${PROBE_SLOT}: currently ${original}; writing ${probe}`);

  const t0 = Date.now();
  const r = await drv.setSwitchTypes([{ slot: PROBE_SLOT, switchId: probe }]);
  console.log(`  setSwitchTypes -> ok=${r.ok} verified=${r.verified} ${r.note ?? r.error ?? ''}`);
  console.log(`  (that call's own read-back finished at +${Date.now() - t0}ms)`);

  for (let i = 0; i < 8; i++) {
    const v = await read();
    console.log(`  +${String(Date.now() - t0).padStart(5)}ms  slot reads ${v}`);
    if (v === probe) break;
    await new Promise((res) => setTimeout(res, 150));
  }

  console.log(`restoring slot ${PROBE_SLOT} to ${original}`);
  await drv.setSwitchTypes([{ slot: PROBE_SLOT, switchId: original }]);
  await new Promise((res) => setTimeout(res, 400));
  console.log(`  final: ${await read()}`);

  await ch.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
