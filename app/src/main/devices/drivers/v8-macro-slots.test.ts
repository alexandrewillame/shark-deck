import { describe, expect, it } from 'vitest';
import type { Macro } from '@shared/types/macros';
import { V8_MACRO_BASE, V8_MACRO_STRIDE, v8MacroName } from '@shared/mouse-wire';
import { ATTACK_SHARK_V8 } from '../catalog/v8';
import { CompxMouse8K } from './compx-mouse-8k';

/**
 * Which slot a V8 macro goes to. Pushing a library macro again used to fill
 * another slot with it every time (a library id never matches an onboard
 * one), until the mouse had no room left.
 */
const named = (name: string) => {
  const b = new Uint8Array(32);
  b[0] = name.length;
  [...name].forEach((c, i) => (b[1 + i] = c.charCodeAt(0)));
  b[0x1f] = 1;
  return b;
};
const macro = (id: string, name: string): Macro => ({
  id,
  name,
  repeatCount: 1,
  steps: [
    { type: 'key', action: 'down', value: '04' },
    { type: 'key', action: 'up', value: '04' },
  ],
});

function mouse(held: Record<number, string>) {
  const drv = new CompxMouse8K({
    descriptor: ATTACK_SHARK_V8,
    channel: {} as never,
    onWarning: () => {},
  });
  const wrote: number[] = [];
  const slotOf = (offset: number) => (offset - V8_MACRO_BASE) / V8_MACRO_STRIDE;
  const raw = drv as unknown as {
    readBlock: (o: number, n: number) => Promise<Uint8Array>;
    writeSetting: (o: number) => Promise<unknown>;
  };
  raw.readBlock = async (o: number, n: number) => {
    const name = held[slotOf(o)];
    return name ? named(name) : new Uint8Array(n).fill(0xff);
  };
  raw.writeSetting = async (o: number) => {
    wrote.push(slotOf(o));
    return { ok: true, verified: 'unverified' };
  };
  return { drv, wrote };
}

describe('V8 macro slots', () => {
  it('puts a macro pushed again back in the slot holding its name', async () => {
    const { drv, wrote } = mouse({ 0: 'Alpha', 1: 'Beta' });
    await drv.saveMacro(macro('library-uuid', 'Beta'));
    expect(wrote).toEqual([1]);
  });

  it('knows a name by how the mouse keeps it: 30 ASCII characters, ? for the rest', async () => {
    const long = 'Crème brûlée, then a very long name indeed';
    expect(v8MacroName(long)).toBe('Cr?me br?l?e, then a very long');
    expect(v8MacroName('  ')).toBe('Macro');
    const { drv, wrote } = mouse({ 0: 'Alpha', 3: v8MacroName(long) });
    await drv.saveMacro(macro('library-uuid', long));
    expect(wrote).toEqual([3]);
  });

  it('takes the first empty slot for a new one, or the slot it is given', async () => {
    const { drv, wrote } = mouse({ 0: 'Alpha', 1: 'Beta' });
    await drv.saveMacro(macro('library-uuid', 'Gamma'));
    await drv.saveMacro(macro('library-uuid', 'Gamma'), 5);
    expect(wrote).toEqual([2, 5]);
    expect((await drv.saveMacro(macro('x', 'y'), 16)).ok).toBe(false);
  });
});
