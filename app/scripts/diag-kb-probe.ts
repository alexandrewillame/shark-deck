/**
 * One-shot evidence gathering for three open questions.
 *
 *   npx vite-node --config vitest.config.ts scripts/diag-kb-probe.ts
 *
 * 1. Which Fn-layer slots decode as firmware-owned, and which PHYSICAL keys
 *    those are — the reported "z/x/c/v/enter/arrows are system keys but not
 *    flagged" needs the real per-slot kinds, not the 28-entry factory table.
 * 2. Does `swapWasd` (KBOPTION byte 6) actually take on this board? Written
 *    and then restored to whatever it was.
 * 3. What actuation/release pairs does the board actually report? The
 *    "Link to actuation" state is derived from their difference, so the real
 *    quantisation decides what tolerance that needs.
 */
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { KB_FN_DEFAULT_SLOTS } from '../src/shared/keyboard-fn-defaults';

async function main() {
  const cands = (await enumerate()).filter(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  if (!cands.length) {
    console.error('keyboard not found — close SharkDeck / qmk.top first');
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

  const layout = d.spec.keyMatrix?.layout ?? [];
  const labelOf = (slot: number) => layout.find((k) => k.slot === slot)?.label ?? `slot ${slot}`;

  // ---------------------------------------------------------------- 1. Fn kinds
  console.log('=== 1. Fn layer, per-slot decode ===');
  const fn = await drv.readKeyBindings('fn');
  if (!fn) {
    console.log('  read failed');
  } else {
    const byKind: Record<string, string[]> = {};
    for (const [slotStr, b] of Object.entries(fn)) {
      const slot = Number(slotStr);
      const bb = b as {
        kind: string;
        code: string | null;
        label?: string;
        raw: number[];
        locked?: boolean;
      };
      // Only slots that carry something — an all-zero quad is an unused slot.
      if (!bb.raw.some((x) => x)) continue;
      const tag = `${labelOf(slot)}(s${slot}) type=${bb.raw[0]} code=${bb.code ?? '-'}${bb.locked ? ' LOCKED' : ''}${
        KB_FN_DEFAULT_SLOTS[slot] ? ' [inFactoryTable]' : ''
      }`;
      (byKind[bb.kind] ??= []).push(tag);
    }
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`  ${kind} (${list.length}):`);
      for (const t of list) console.log(`    ${t}`);
    }
    // The keys the report names, whatever their kind.
    console.log('  --- the reported keys ---');
    for (const want of ['Z', 'X', 'C', 'V', 'Enter', 'Left', 'Right', 'FN', 'Win', 'Tab']) {
      const e = layout.find((k) => k.label.toUpperCase() === want.toUpperCase());
      if (!e || e.slot === undefined) {
        console.log(`    ${want}: not in layout`);
        continue;
      }
      const b = fn[e.slot] as
        { kind: string; code: string | null; raw: number[]; locked?: boolean } | undefined;
      console.log(
        `    ${want.padEnd(6)} slot ${String(e.slot).padStart(3)}  raw=[${b?.raw.join(',') ?? '?'}]  kind=${b?.kind ?? '?'}  locked=${b?.locked ?? false}`,
      );
    }
  }

  // ---------------------------------------------------------------- 2. swapWasd
  console.log('\n=== 2. swapWasd round-trip ===');
  const before = await drv.readKeyboardOptions();
  console.log(`  before: ${JSON.stringify(before)}`);
  if (before) {
    const w = await drv.setKeyboardOptions({ swapWasd: !before.swapWasd });
    console.log(
      `  write !swapWasd -> ok=${w.ok} verified=${w.verified}${w.error ? ' err=' + w.error : ''}`,
    );
    console.log(`  frame: ${(w.frames ?? []).join(' ')}`);
    const mid = await drv.readKeyboardOptions();
    console.log(`  after write: ${JSON.stringify(mid)}`);
    console.log(`  >>> swapWasd ${mid?.swapWasd === !before.swapWasd ? 'TOOK' : 'DID NOT TAKE'}`);
    const r = await drv.setKeyboardOptions({ swapWasd: before.swapWasd });
    const back = await drv.readKeyboardOptions();
    console.log(`  restored -> ok=${r.ok} value=${back?.swapWasd} (was ${before.swapWasd})`);
  }

  // ---------------------------------------------------------------- 3. travel pairs
  console.log('\n=== 3. actuation / release as reported ===');
  const mag = await drv.readMagnetic();
  const pairs = new Map<string, number>();
  for (const k of mag.slice(0, 200)) {
    const key = `act=${k.actuationMm} rel=${k.releaseMm ?? 'undef'} diff=${
      k.releaseMm === undefined ? '-' : (k.actuationMm - k.releaseMm).toFixed(3)
    }`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  for (const [k, n] of [...pairs].sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`  ${n} keys: ${k}`);

  await ch.close();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
