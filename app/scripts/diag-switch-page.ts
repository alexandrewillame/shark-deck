/**
 * Read magnetism page 252 (installed switch id) off a real R85HE.
 *
 *   npx vite-node --config vitest.config.ts scripts/diag-switch-page.ts
 *
 * READ-ONLY. Prints every slot that is not on the board's stock switch, beside
 * its key label.
 *
 * This settled a wrong conclusion. An earlier run read the page as 79 slots of
 * zero and the driver's post-write read-back disagreed with what it had just
 * written, so the feature was written off as "this firmware does not store
 * switch assignments". A later run — after the same writes had had time to
 * commit — found them all present. The page IS stored; the read-back was
 * simply taken too soon.
 */
import { enumerate, HidChannel } from '../src/main/hid/transport';
import { ATTACK_SHARK_R85HE } from '../src/main/devices/catalog/r85he';
import { CompxHeKeyboard } from '../src/main/devices/drivers/compx-he-keyboard';
import { ANSI_79_SG9047 } from '../src/shared/layouts';
import { switchModel } from '../src/shared/keyboard-switches';

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

  const label = new Map(ANSI_79_SG9047.map((k) => [k.slot!, k.label]));

  // Twice, a second apart: a page that reads differently on the second pass is
  // a page whose write had not finished committing, which is exactly the trap
  // the post-write read-back fell into.
  for (const pass of [1, 2]) {
    const page = await drv.readSwitchTypes();
    if (!page) {
      console.log(`pass ${pass}: read returned NULL`);
      continue;
    }
    const set = Object.entries(page).filter(([, id]) => id !== 0);
    console.log(`pass ${pass}: ${Object.keys(page).length} slots, ${set.length} not on stock`);
    for (const [slot, id] of set)
      console.log(
        `    slot ${String(slot).padStart(3)} (${label.get(Number(slot)) ?? '?'}) -> id ${id} ` +
          `${switchModel(id)?.name ?? '(unknown)'}`,
      );
    if (pass === 1) await new Promise((r) => setTimeout(r, 1000));
  }

  await ch.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
