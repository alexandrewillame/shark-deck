/**
 * Dump the R85HE's LIVE Fn-layer matrix, slot by slot, next to the layout.
 *
 *   npx vite-node --config vitest.config.ts scripts/diag-fn-quads.ts
 *
 * READ-ONLY. Drives the real `CompxHeKeyboard.readKeyBindings('fn')` plus a
 * raw chunk dump, so what it prints is exactly what the app sees.
 *
 * This exists because the Fn layer was "fixed" three times from the vendor's
 * static `defaultFnMatrix` alone, and the board kept disagreeing: Fn+F12
 * prints the screen where the table says Volume +, Fn+DEL is Insert where the
 * app said `0x00`. The table describes SOME firmware; the only way to know
 * what THIS one does is to ask it.
 */
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { ANSI_79_SG9047 } from '../src/shared/layouts';
import { KB_FN_DEFAULT_SLOTS } from '../src/shared/keyboard-fn-defaults';
import { decodeKeyQuad } from '../src/shared/keyboard-fn-codes';

/** The keys the user reported wrong, by layout label. */
const WATCH = new Set([
  'F1',
  'F2',
  'F3',
  'F5',
  'F6',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
  'DEL',
  'PgUp',
  'PgDn',
  '2@',
  '8*',
  '\\|',
  ']}',
  'Up',
  'Down',
]);

async function main() {
  const cands = (await enumerate()).filter(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cands.length) {
    console.error('No Compx vendor collection found — is the keyboard connected?');
    console.error('Close SharkDeck / ATK HUB / qmk.top first; they hold the handle.');
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

  for (const layer of ['fn', 'base'] as const) {
    console.log(`\n===== ${layer.toUpperCase()} LAYER =====`);
    const bindings = await drv.readKeyBindings(layer);
    if (!bindings) {
      console.log('  read returned NULL — the board did not answer.');
      continue;
    }
    const nonZero = Object.values(bindings).filter((b) => b.raw.some((x) => x)).length;
    console.log(`  ${Object.keys(bindings).length} slots, ${nonZero} non-zero`);

    console.log('  label  slot  live quad            decode                     factory quad');
    for (const k of ANSI_79_SG9047) {
      if (layer === 'fn' && !WATCH.has(k.label)) continue;
      if (layer === 'base' && k.label !== 'F12' && k.label !== 'DEL') continue;
      const slot = k.slot!;
      const b = bindings[slot];
      if (!b) continue;
      const def = KB_FN_DEFAULT_SLOTS[slot];
      const dec = decodeKeyQuad(b.raw);
      console.log(
        '  ' +
          k.label.padEnd(6) +
          String(slot).padStart(4) +
          '  [' +
          b.raw.map((x) => String(x).padStart(3)).join(',') +
          ']  ' +
          `${dec.kind}/${dec.label || '-'}`.padEnd(26) +
          (def ? '[' + def.raw.map((x) => String(x).padStart(3)).join(',') + ']' : '(none)'),
      );
    }
  }

  // Every non-zero Fn slot, so an alignment shift is visible as a block.
  console.log('\n===== EVERY NON-ZERO Fn SLOT =====');
  const fn = await drv.readKeyBindings('fn');
  const bySlot = new Map(ANSI_79_SG9047.map((k) => [k.slot!, k.label]));
  for (const [slotStr, b] of Object.entries(fn ?? {})) {
    if (!b.raw.some((x) => x)) continue;
    const slot = Number(slotStr);
    const dec = decodeKeyQuad(b.raw);
    console.log(
      `  slot ${String(slot).padStart(3)} (${(bySlot.get(slot) ?? '?').padEnd(6)}) ` +
        `[${b.raw.map((x) => String(x).padStart(3)).join(',')}]  ${dec.kind}/${dec.label || '-'}`,
    );
  }

  await ch.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
