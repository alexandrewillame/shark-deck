import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Macro, MacroStep } from '@shared/types/macros';
import { asKeyboardStores } from '@shared/keyboard-macro';
import { liveDevice, settle } from '../../../../test/lib/simDevice';
import { sdMock } from '../../../../test/lib/sdStub';
import { KEYBOARDS_BY_ID } from '../../../main/devices/catalog/keyboards';
import { clearDeviceCache } from '../../state/deviceCache';
import { MacroEditor } from './MacroEditor';

/**
 * The Macros tab on a keyboard: its macros in numbered slots (64 on an R98
 * HE), Push to the one chosen, Timing applied to the macro being edited, a
 * macro on the board copied into the library, a library row deleted from the
 * row, and unsaved edits saved on the way to another macro.
 */
const r98 = KEYBOARDS_BY_ID.get(3743)!;
const key = (action: 'down' | 'up', value: string): MacroStep => ({ type: 'key', action, value });
const wait = (ms: number): MacroStep => ({ type: 'delay', ms });

const HELLO: Macro = {
  id: 'lib-hello',
  name: 'Hello',
  repeatCount: 1,
  steps: [
    key('down', '0b'),
    wait(761),
    key('up', '0b'),
    wait(40),
    key('down', '08'),
    wait(63),
    key('up', '08'),
  ],
};
/** On the board: an unknown macro in the first slot, Hello as stored in the second. */
const ON_BOARD: Macro[] = [
  { id: 'onboard-0', name: 'Macro 1', repeatCount: 1, steps: [key('down', '04'), key('up', '04')] },
  { id: 'onboard-1', name: 'Macro 2', repeatCount: 1, steps: asKeyboardStores(HELLO.steps) },
];

async function open() {
  render(<MacroEditor device={liveDevice(r98, 'kb')} />);
  await settle();
}

describe('MacroEditor on a keyboard', () => {
  beforeEach(() => {
    clearDeviceCache();
    sdMock.readMacros!.mockResolvedValue(ON_BOARD);
    sdMock.listMacroLibrary!.mockResolvedValue([HELLO]);
    sdMock.pushMacroToDevice!.mockResolvedValue({ ok: true, verified: 'match' });
    sdMock.saveMacroLibraryEntry!.mockResolvedValue([]);
  });

  it('pushes to the slot holding the macro, or to the one chosen', async () => {
    await open();
    const select = screen.getByLabelText('Push to') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Macro 1 · on the device',
      'Macro 2 · Hello',
      'Macro 3 · empty',
    ]);
    // Hello is already the board's second macro (matched by what it holds)
    expect(select.value).toBe('1');
    fireEvent.change(select, { target: { value: '2' } });
    fireEvent.click(screen.getByText('Push to device'));
    await settle();
    expect(sdMock.pushMacroToDevice).toHaveBeenCalledWith('kb', 'lib-hello', 2);
  });

  it('applies Timing to the macro being edited, and puts its own pauses back', async () => {
    await open();
    const holds = () =>
      [...document.querySelectorAll<HTMLInputElement>('.macro-step-times input')].map(
        (i) => i.value,
      );
    expect(holds()).toEqual(['761', '63']);
    fireEvent.click(screen.getByText('Even'));
    expect(holds()).toEqual(['50', '50']);
    expect(screen.getAllByText('Unsaved').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('As typed'));
    expect(holds()).toEqual(['761', '63']);
  });

  it('copies a macro on the board into the library, named by its slot', async () => {
    await open();
    fireEvent.click(screen.getAllByLabelText('Copy to library')[0]!);
    await settle();
    expect(sdMock.saveMacroLibraryEntry).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Keyboard macro 1', steps: ON_BOARD[0]!.steps }),
    );
  });

  it('deletes a library macro from its own row, after asking', async () => {
    const OTHER: Macro = { ...HELLO, id: 'lib-other', name: 'Other' };
    sdMock.listMacroLibrary!.mockResolvedValue([HELLO, OTHER]);
    await open();
    fireEvent.click(screen.getByLabelText('Delete “Other” from the library'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Delete this macro?')).toBeTruthy();
    fireEvent.click(within(dialog).getByText('Delete'));
    await settle();
    expect(sdMock.deleteMacroLibraryEntry).toHaveBeenCalledWith('lib-other');
    // the macro being edited stays open
    expect((document.querySelector('input.macro-name') as HTMLInputElement).value).toBe('Hello');
  });

  it('offers to save unsaved edits before opening another macro', async () => {
    const OTHER: Macro = { ...HELLO, id: 'lib-other', name: 'Other' };
    sdMock.listMacroLibrary!.mockResolvedValue([HELLO, OTHER]);
    await open();
    fireEvent.click(screen.getByText('Even'));
    fireEvent.click(screen.getByText('Other'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Save this macro first?')).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Keep editing', 'Discard', 'Save']);
    fireEvent.click(within(dialog).getByText('Save'));
    await settle();
    // Hello saved with its even holds, then Other opened
    const saved = sdMock.saveMacroLibraryEntry!.mock.calls[0]![0] as Macro;
    expect(saved.id).toBe('lib-hello');
    expect(saved.steps.filter((x) => x.type === 'delay').map((x) => x.ms)).toContain(50);
    expect((document.querySelector('input.macro-name') as HTMLInputElement).value).toBe('Other');
  });
});
