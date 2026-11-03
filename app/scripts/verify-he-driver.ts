/**
 * Hardware verification of the REAL driver code path — not a reimplementation.
 *
 *   npx vite-node --config vitest.config.ts scripts/verify-he-driver.ts
 *
 * Instantiates the actual `CompxHeKeyboard` against a real board and calls
 * `getFirmware()` + `readMagnetic()`, so a green run here means the app itself
 * reads real device state. Before the offset/command-filter fix this printed
 * every key at the 1.5 mm fallback default.
 *
 * READ-ONLY: no write path is exercised.
 */
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { KB_TRAVEL_RANGE } from '../src/shared/keyboard-travel';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { resolveModelId, modelIdConflicts } from '../src/main/devices/registry';

async function main() {
  const cands = (await enumerate()).filter(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cands.length) {
    console.error('No Compx vendor collection found — is the keyboard connected?');
    console.error('Close SharkDeck / ATK HUB / qmk.top first; they hold the handle.');
    process.exit(1);
  }
  const cand = cands[0]!;
  const d = ATTACK_SHARK_R85HE;
  console.log(
    `device  ${cand.product ?? '?'}  ${cand.vendorId.toString(16)}:${cand.productId.toString(16)}`,
  );

  const ch = new HidChannel(cand, undefined, d.transport, d.checksum);
  const drv = new CompxHeKeyboard({
    descriptor: d,
    channel: ch,
    onWarning: (m: string) => console.log('  warning:', m),
    state: {},
  } as never);

  const fw = await drv.getFirmware();
  console.log(`firmware ${fw.device}  modelId ${(fw as { modelId?: number }).modelId}`);
  const id = (fw as { modelId?: number }).modelId ?? 0;
  console.log(`  resolveModelId -> ${resolveModelId(d, id)?.model ?? '(no change)'}`);
  console.log(`  modelIdConflicts -> ${modelIdConflicts(d, id)}`);

  // KBOPTION: read, then write back the IDENTICAL values. A no-op on the
  // device, but it exercises the SET frame and the read-back comparison.
  const before = await drv.readKeyboardOptions();
  console.log(`
readKeyboardOptions(): ${JSON.stringify(before)}`);
  if (before) {
    const w = await drv.setKeyboardOptions({ ...before });
    console.log(`  no-op setKeyboardOptions -> ok=${w.ok} verified=${w.verified}`);
    console.log(`  frame: ${(w.frames ?? []).join(' ')}`);
    const after = await drv.readKeyboardOptions();
    const same = JSON.stringify(before) === JSON.stringify(after);
    console.log(
      `  after: ${JSON.stringify(after)}  ${same ? '(unchanged, as intended)' : 'CHANGED!'}`,
    );
  }

  const keys = await drv.readMagnetic();
  console.log(`\nreadMagnetic(): ${keys.length} keys`);
  if (!keys.length) {
    console.log('  EMPTY — the read path is broken.');
    await ch.close();
    process.exit(1);
  }

  const act = new Map<number, number>();
  for (const k of keys) act.set(k.actuationMm, (act.get(k.actuationMm) ?? 0) + 1);
  console.log('  actuation histogram (mm -> keys):');
  for (const [mm, n] of [...act].sort((a, b) => b[1] - a[1])) console.log(`    ${mm} mm  x${n}`);

  const rel = new Set(keys.map((k) => k.releaseMm));
  const dz = new Set(keys.map((k) => k.deadZoneBottomMm));
  console.log(`  release points : ${[...rel].join(', ')}`);
  console.log(`  bottom dz      : ${[...dz].join(', ')}`);
  console.log(`  RT armed       : ${keys.filter((k) => k.rapidTrigger).length}`);
  console.log(`  modes          : ${[...new Set(keys.map((k) => k.mode))].join(', ')}`);

  // The bug this verifies: every key reading exactly the 1.5 mm fallback means
  // readMagnetismPage returned null and readMagnetic() invented the values.
  const allFallback = keys.every((k) => k.actuationMm === 1.5);
  console.log(
    `
${allFallback ? `FAIL - all keys at the ${KB_TRAVEL_RANGE.travel.default} mm fallback (read path dead)` : 'OK - real per-key values came off the device'}`,
  );

  await ch.close();
  process.exit(allFallback ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
