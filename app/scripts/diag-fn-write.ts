/**
 * Exercise the Fn-layer WRITE path against a real R85HE, safely.
 *
 *   npx vite-node --config vitest.config.ts scripts/diag-fn-write.ts
 *
 * MUTATING, but self-restoring and with a safety net:
 *
 *   1. dump the whole Fn matrix to a JSON file first
 *   2. pick a slot that is currently EMPTY (so a failed restore leaves nothing lost)
 *   3. write one binding to it
 *   4. re-read and diff the WHOLE matrix — the point is to prove that exactly
 *      one quad changed, since `setFnSlot` rewrites all 126 writable slots
 *   5. restore the original bytes and confirm the matrix is byte-identical
 *
 * If step 4 shows widespread damage the dump from step 1 is the way back.
 * Pass a path as argv[2] to restore from a dump instead of running the test.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';

const DUMP = 'fn-matrix-dump.json';

/** Reach the protected read/write without widening the driver's public API. */
type Probe = {
  fnArgs(): Promise<(chunk: number) => number[]>;
  setFnSlot(
    slot: number,
    hi: number,
    lo: number,
  ): Promise<{ ok: boolean; verified: string; error?: string }>;
  readKeyBindings(l: 'base' | 'fn'): Promise<Record<number, unknown> | null>;
};

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
  const probe = drv as unknown as Probe;

  // The raw matrix, via the same paged read the driver uses.
  const readRaw = async (): Promise<number[] | null> => {
    const args = await probe.fnArgs();
    return (
      drv as unknown as {
        readMatrixChunks(c: number, a: (n: number) => number[]): Promise<number[] | null>;
      }
    ).readMatrixChunks(144, args);
  };

  const before = await readRaw();
  if (!before) {
    console.error('Could not read the Fn matrix — aborting without writing anything.');
    await ch.close();
    process.exit(1);
  }
  writeFileSync(DUMP, JSON.stringify(before));
  console.log(`dumped ${before.length} bytes (${before.length / 4} slots) to ${DUMP}`);

  const quad = (b: number[], s: number) => [b[s * 4], b[s * 4 + 1], b[s * 4 + 2], b[s * 4 + 3]];
  const diff = (a: number[], b: number[]) => {
    const out: number[] = [];
    for (let s = 0; s * 4 + 3 < Math.min(a.length, b.length); s++) {
      if (quad(a, s).some((v, i) => v !== quad(b, s)[i])) out.push(s);
    }
    return out;
  };

  // Pick an empty slot inside the R85HE's real range (max slot 95) — writing
  // one that already carries a factory binding risks losing it if restore fails.
  let target = -1;
  for (let s = 0; s < 96; s++) {
    if (quad(before, s).every((v) => v === 0)) {
      target = s;
      break;
    }
  }
  if (target < 0) {
    console.error('No empty Fn slot to test with — aborting.');
    await ch.close();
    process.exit(1);
  }
  console.log(`target slot      : ${target} (currently ${JSON.stringify(quad(before, target))})`);

  // 0x04 = HID usage 'a' — arbitrary, and removed again below.
  const r = await probe.setFnSlot(target, 0x00, 0x04);
  console.log(
    `setFnSlot        : ok=${r.ok} verified=${r.verified}${r.error ? ' error=' + r.error : ''}`,
  );

  const after = await readRaw();
  if (!after) {
    console.error(
      'Read-back failed after the write — restore manually: node … scripts/diag-fn-write.ts ' +
        DUMP,
    );
    await ch.close();
    process.exit(1);
  }
  const changed = diff(before, after);
  console.log(`slots changed    : [${changed.join(', ')}]  (expected exactly [${target}])`);
  console.log(
    `  slot ${target} now  : ${JSON.stringify(quad(after, target))}  (expected [0,0,4,0])`,
  );
  if (changed.length !== 1 || changed[0] !== target) {
    console.log('  !! MORE THAN THE TARGET CHANGED — the write format is wrong. Restoring.');
  }

  // Restore.
  const orig = quad(before, target);
  const rr = await probe.setFnSlot(target, orig[1]!, orig[2]!);
  const restored = await readRaw();
  const stillOff = restored ? diff(before, restored) : null;
  console.log(`restore          : ok=${rr.ok} verified=${rr.verified}`);
  console.log(
    `after restore    : ${stillOff === null ? 'read failed' : stillOff.length === 0 ? 'byte-identical to the dump ✓' : 'STILL DIFFERS at [' + stillOff.join(', ') + ']'}`,
  );

  await ch.close();
}

async function restore(path: string) {
  const want: number[] = JSON.parse(readFileSync(path, 'utf8'));
  const cands = (await enumerate()).filter(
    (c) => c.vendorId === 0x3151 && c.usagePage === 0xffff && c.usage === 0x02 && c.path,
  );
  const d = ATTACK_SHARK_R85HE;
  const ch = new HidChannel(cands[0]!, undefined, d.transport, d.checksum, { opTimeoutMs: 2500 });
  const drv = new CompxHeKeyboard({
    descriptor: d,
    channel: ch,
    onWarning: () => {},
    state: {},
  } as never);
  const probe = drv as unknown as Probe;
  for (let s = 0; s < 96; s++) {
    const q = [want[s * 4], want[s * 4 + 1], want[s * 4 + 2]];
    await probe.setFnSlot(s, q[1]!, q[2]!);
  }
  console.log('restored from ' + path);
  await ch.close();
}

const arg = process.argv[2];
if (arg && existsSync(arg)) {
  restore(arg).catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error('fatal:', e);
    process.exit(1);
  });
}
