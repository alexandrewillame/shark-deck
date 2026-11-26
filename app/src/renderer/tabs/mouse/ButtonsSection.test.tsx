import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Macro } from '@shared/types/macros';
import type { ButtonMapping } from '@shared/types/mouse-settings';
import { liveDevice, settle } from '../../../../test/lib/simDevice';
import { sdMock } from '../../../../test/lib/sdStub';
import { CATALOG } from '../../../main/devices/catalog';
import { bekenMouseRoster } from '../../../main/devices/catalog/beken-mice';
import { clearDeviceCache } from '../../state/deviceCache';
import { ButtonsSection } from './ButtonsSection';

/**
 * A macro given to a mouse button: the slot written is the slot the button
 * plays, the picker says which macro a button plays as read back, and a mouse
 * holding one macro asks before a second button changes it.
 */
const model = (id: string) => [...CATALOG, ...bekenMouseRoster()].find((d) => d.model === id)!;
const steps: Macro['steps'] = [
  { type: 'key', action: 'down', value: '04' },
  { type: 'key', action: 'up', value: '04' },
];
const macro = (id: string, name: string): Macro => ({ id, name, repeatCount: 1, steps });
const MACRO = { actionKey: 'macro', action: 6 } as const;

async function open(modelId: string, buttons: Record<number, ButtonMapping>) {
  sdMock.readButtons!.mockResolvedValue(buttons);
  render(
    <ButtonsSection
      device={liveDevice(model(modelId), 'm')}
      active={null}
      onActive={() => undefined}
    />,
  );
  await settle();
}
/** The macro picker in button n's row. */
const picker = (n: number) =>
  document
    .querySelectorAll('.btn-row:not(.btn-row-head)')
    [n - 1]!.querySelector<HTMLSelectElement>('.btn-row-options select')!;

describe('ButtonsSection macros', () => {
  beforeEach(() => {
    clearDeviceCache();
    sdMock.pushMacroToDevice!.mockResolvedValue({ ok: true, verified: 'unverified' });
    sdMock.setButtonMapping!.mockResolvedValue({ ok: true, verified: 'match' });
  });

  it('binds the slot it wrote: the one holding the macro, else the first empty one', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([
      macro('lib-cafe', 'Café au lait'),
      macro('lib-new', 'New'),
    ]);
    // A V8 keeps 30 ASCII characters of a name, `?` for the rest.
    sdMock.readMacros!.mockResolvedValue([
      { ...macro('', 'Other'), id: 'onboard-0' },
      { ...macro('', 'Caf? au lait'), id: 'onboard-2' },
    ]);
    await open('attack-shark-v8', { 3: { ...MACRO, macroSlot: 0 } });

    // The macro button 4 plays has no library copy: offered as it is.
    expect(picker(4).value).toBe('onboard-0');
    expect([...picker(4).options].map((o) => o.textContent)).toContain('Other · on the device');

    fireEvent.change(picker(4), { target: { value: 'lib-cafe' } });
    await settle();
    expect(sdMock.pushMacroToDevice).toHaveBeenLastCalledWith('m', 'lib-cafe', 2);
    expect(sdMock.setButtonMapping).toHaveBeenLastCalledWith(
      'm',
      3,
      expect.objectContaining({ macroId: 'lib-cafe', macroSlot: 2 }),
    );

    fireEvent.change(picker(4), { target: { value: 'lib-new' } });
    await settle();
    expect(sdMock.pushMacroToDevice).toHaveBeenLastCalledWith('m', 'lib-new', 1);
    expect(sdMock.setButtonMapping).toHaveBeenLastCalledWith(
      'm',
      3,
      expect.objectContaining({ macroSlot: 1 }),
    );
  });

  it('binds a macro the mouse already holds where it is, pushing nothing', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([]);
    sdMock.readMacros!.mockResolvedValue([{ ...macro('', 'Other'), id: 'onboard-5' }]);
    await open('attack-shark-v8', { 3: { ...MACRO } });
    fireEvent.change(picker(4), { target: { value: 'onboard-5' } });
    await settle();
    expect(sdMock.pushMacroToDevice).not.toHaveBeenCalled();
    expect(sdMock.setButtonMapping).toHaveBeenLastCalledWith(
      'm',
      3,
      expect.objectContaining({ actionKey: 'macro', macroSlot: 5 }),
    );
  });

  it('writes nothing when every slot holds another macro', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([macro('lib-new', 'New')]);
    sdMock.readMacros!.mockResolvedValue(
      Array.from({ length: 16 }, (_, s) => ({ ...macro('', `M${s + 1}`), id: `onboard-${s}` })),
    );
    await open('attack-shark-v8', { 3: { ...MACRO, macroSlot: 0 } });
    fireEvent.change(picker(4), { target: { value: 'lib-new' } });
    await settle();
    expect(sdMock.pushMacroToDevice).not.toHaveBeenCalled();
    expect(sdMock.setButtonMapping).not.toHaveBeenCalled();
  });

  it('sends a one-key shortcut once its key is in, not on a modifier picked first', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([]);
    sdMock.readMacros!.mockResolvedValue([]);
    await open('attack-shark-x8-pro', { 3: { actionKey: 'combo', action: 0x05, combo: [] } });
    const keys = () =>
      document
        .querySelectorAll('.btn-row:not(.btn-row-head)')[3]!
        .querySelectorAll<HTMLSelectElement>('.btn-row-combo select');
    fireEvent.change(keys()[0]!, { target: { value: 'e0' } }); // Left Ctrl
    await settle();
    expect(sdMock.setButtonMapping).not.toHaveBeenCalled();
    fireEvent.change(keys()[1]!, { target: { value: '6' } }); // C
    await settle();
    expect(sdMock.setButtonMapping).toHaveBeenLastCalledWith(
      'm',
      3,
      expect.objectContaining({ actionKey: 'combo', combo: [0xe0, 0x06] }),
    );
  });

  it('offers the X8 PRO its fire key and easy aim, with nothing to set', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([]);
    sdMock.readMacros!.mockResolvedValue([]);
    await open('attack-shark-x8-pro', {});
    const action = document
      .querySelectorAll('.btn-row:not(.btn-row-head)')[3]!
      .querySelector<HTMLSelectElement>('.btn-row-action select')!;
    expect([...action.options].map((o) => o.textContent)).toEqual(
      expect.arrayContaining(['Rapid fire', 'Easy aim']),
    );
    fireEvent.change(action, { target: { value: 'firepower' } });
    await settle();
    const [, button, mapping] = sdMock.setButtonMapping!.mock.calls.at(-1)!;
    expect(button).toBe(3);
    expect(mapping).toMatchObject({ actionKey: 'firepower' });
    expect(mapping).not.toHaveProperty('fire');
    expect(document.querySelector('.btn-row-fire')).toBeNull();
  });

  // Its owner (2026-11-25): choosing "Button" put Left click on any button.
  it('starts the Button action on the button’s own click', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([]);
    sdMock.readMacros!.mockResolvedValue([]);
    await open('attack-shark-x8-pro', {});
    const action = (n: number) =>
      document
        .querySelectorAll('.btn-row:not(.btn-row-head)')
        [n - 1]!.querySelector<HTMLSelectElement>('.btn-row-action select')!;
    const sent = () => sdMock.setButtonMapping!.mock.calls.at(-1)!.slice(1);
    fireEvent.change(action(4), { target: { value: 'button' } });
    await settle();
    expect(sent()).toEqual([3, expect.objectContaining({ actionKey: 'button', param: 0x1000 })]);
    fireEvent.change(action(5), { target: { value: 'button' } });
    await settle();
    expect(sent()).toEqual([4, expect.objectContaining({ actionKey: 'button', param: 0x0800 })]);
    // The DPI button gives no click of its own: the list's first.
    fireEvent.change(action(6), { target: { value: 'button' } });
    await settle();
    expect(sent()).toEqual([5, expect.objectContaining({ actionKey: 'button', param: 0x0100 })]);
  });

  it('asks before a mouse holding one macro plays another on every button', async () => {
    sdMock.listMacroLibrary!.mockResolvedValue([macro('lib-a', 'Alpha'), macro('lib-b', 'Beta')]);
    sdMock.readMacros!.mockResolvedValue([{ ...macro('', 'Alpha'), id: 'onboard-0' }]);
    await open('attack-shark-x8-pro', {
      3: { ...MACRO, macroSlot: 0 },
      4: { ...MACRO, macroSlot: 0 },
    });
    // Read back as "plays its macro", named by the library macro it is.
    expect(picker(4).value).toBe('lib-a');

    fireEvent.change(picker(5), { target: { value: 'lib-b' } });
    expect(screen.getByText('Change the macro on this mouse?')).toBeTruthy();
    expect(sdMock.pushMacroToDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Change it'));
    await settle();
    expect(sdMock.pushMacroToDevice).toHaveBeenCalledWith('m', 'lib-b', undefined);
    expect(sdMock.setButtonMapping).toHaveBeenCalledWith(
      'm',
      4,
      expect.objectContaining({ macroId: 'lib-b', macroSlot: 0 }),
    );
  });
});
