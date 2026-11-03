/**
 * Fn-layer read/write diagnostic for the R85HE.
 *
 *   npx vite-node --config vitest.config.ts scripts/diag-fn-layer.ts
 *
 * READ-ONLY. Drives the real `CompxHeKeyboard` (not a reimplementation) and
 * probes the board with a known-good GET_USB_VERSION after each step, so a
 * frame that wedges the MCU is attributed to the step that sent it rather than
 * showing up later as a generic hang.
 *
 * This exists because "reading the Fn layer freezes the keyboard" was
 * diagnosed three different wrong ways from the code alone. The answer was a
 * wrong argument layout on GET_FN, and only a per-frame liveness probe showed
 * it: the base sweep completes all 8 chunks, the Fn sweep died on chunk 0.
 */
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { buildFrame } from '../src/main/hid/frame';

const GET_USB_VERSION = 143;

const hex = (b: Uint8Array | null, n = 12) =>
  b
    ? Array.from(b.subarray(0, n))
        .map((x) => x.toString(16).padStart(2, '0'))
        .join(' ')
    : '(null)';

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

  /** Is the board still talking? GET_USB_VERSION is the GET known to answer. */
  const alive = async (): Promise<string> => {
    try {
      return await ch.transaction(async (io) => {
        await io.write(
          buildFrame({
            reportId: 0,
            command: GET_USB_VERSION,
            reportLength: d.reportLength,
            checksum: d.checksum,
          }),
        );
        await new Promise((r) => setTimeout(r, 30));
        const r = await io.read(250, d.reportLength);
        if (!r) return 'NO REPLY';
        return r[1] === GET_USB_VERSION && (r[2] || r[3])
          ? `alive (${hex(r, 10)})`
          : `echo/empty (${hex(r, 10)})`;
      });
    } catch (e) {
      return `THREW: ${String((e as Error).message).slice(0, 70)}`;
    }
  };

  const step = async (name: string, fn: () => Promise<unknown>) => {
    const t0 = Date.now();
    let note: string;
    try {
      const out = await fn();
      const n = out && typeof out === 'object' ? Object.keys(out as object).length : 0;
      note = out === null ? 'returned null' : `ok (${n} slots)`;
    } catch (e) {
      note = `THREW ${String((e as Error).message).slice(0, 60)}`;
    }
    console.log(`${name.padEnd(22)} ${String(Date.now() - t0).padStart(5)}ms  ${note}`);
    const a = await alive();
    console.log(`  liveness after       : ${a}`);
    return a.startsWith('alive');
  };

  console.log(`baseline liveness      : ${await alive()}\n`);

  const opts = await drv.readKeyboardOptions();
  console.log(`readKeyboardOptions()  : ${JSON.stringify(opts)}`);
  console.log(
    `  -> Fn args prefix    : [fnOS=${opts?.fnOs === 'mac' ? 1 : 0}, fnProfile=${opts?.fnProfile ?? 0}, 0xff, chunk]\n`,
  );

  if (!(await step('readKeyBindings(base)', () => drv.readKeyBindings('base'))))
    return void (await ch.close());
  const fn = await drv.readKeyBindings('fn');
  await step('readKeyBindings(fn)', async () => fn);

  if (fn) {
    const bound = Object.entries(fn).filter(([, b]) => (b as { code?: string }).code);
    console.log(`\nFn layer: ${bound.length} slots carry a binding. First 12:`);
    for (const [slot, b] of bound.slice(0, 12)) {
      const v = b as { code?: string; kind?: string; label?: string };
      console.log(
        `  slot ${String(slot).padStart(3)}  code=${v.code ?? '-'}  kind=${v.kind ?? '-'}  ${v.label ?? ''}`,
      );
    }
    if (bound.length === 0) console.log('  (none — the sweep answered but every quad was empty)');
  }

  await ch.close();
  console.log('\nDone — board still answering.');
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
