import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDevice } from '@shared/types/live';
import { sdMock } from '../../../test/lib/sdStub';
import { liveDevice } from '../../../test/lib/simDevice';
import { virtualDescriptors } from '../../main/devices/virtual';
import { LeaveDialog } from './LeaveDialog';
import {
  confirmLeave,
  installLeaveGuardHost,
  registerPendingChange,
  resetLeaveGuard,
  type LeaveExit,
  type PendingChange,
  type PendingKind,
} from '../state/leaveGuard';
import { useStore } from '../state/store';

/**
 * The prompt for leaving with a change nobody applied (state/leaveGuard.ts):
 * when it asks, what it says, and what each answer does. The panes that
 * register those changes are driven for real in
 * screens/DeviceConfig.leave.test.tsx.
 */

const descriptors = virtualDescriptors();
const KB = liveDevice(
  descriptors.find((d) => d.displayName === 'Attack Shark R85HE')!,
  'kb',
);
const MOUSE = liveDevice(
  descriptors.find((d) => d.kind === 'mouse')!,
  'mouse',
);

function change(
  over: {
    dirty?: boolean;
    label?: string;
    kind?: PendingKind;
    commit?: (() => Promise<boolean>) | null;
  } = {},
): PendingChange {
  const commit = over.commit === null ? undefined : (over.commit ?? vi.fn(async () => true));
  return {
    kind: over.kind ?? 'apply',
    dirty: () => over.dirty ?? true,
    label: () => over.label ?? 'Caps Lock → Esc',
    commit,
  };
}

function ask(deviceId: string | null, exit: LeaveExit = 'leave') {
  const proceed = vi.fn();
  act(() => confirmLeave(deviceId, proceed, exit));
  return proceed;
}

const dialogButtons = () =>
  screen
    .getAllByRole('button')
    .filter((b) => b.closest('[role=dialog]'))
    .map((b) => b.textContent);

beforeEach(() => {
  resetLeaveGuard();
  useStore.setState({ devices: [KB, MOUSE] });
});

describe('the leave prompt', () => {
  it('goes straight through when nothing would be lost', () => {
    registerPendingChange('kb', change({ dirty: false }));
    render(<LeaveDialog />);
    const proceed = ask('kb');
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks about a change nobody applied, naming it, with Keep editing focused', () => {
    registerPendingChange('kb', change());
    render(<LeaveDialog />);
    const proceed = ask('kb');
    expect(proceed).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Apply this change before leaving?' });
    expect(dialog.textContent).toContain(
      "Caps Lock → Esc hasn't been applied to the keyboard yet. If you leave now, it's discarded.",
    );
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and leave', 'Apply and leave']);
    // The safe answer has the focus: a stray Enter keeps the work.
    expect(document.activeElement?.textContent).toBe('Keep editing');
  });

  it('Keep editing, Escape and the backdrop all stay put', () => {
    const c = change();
    registerPendingChange('kb', c);
    render(<LeaveDialog />);
    const answers = [
      () => fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })),
      () => fireEvent.keyDown(window, { key: 'Escape' }),
      () => fireEvent.mouseDown(document.querySelector('.modal-scrim')!),
    ];
    for (const answer of answers) {
      const proceed = ask('kb');
      answer();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(proceed).not.toHaveBeenCalled();
    }
    expect(c.commit).not.toHaveBeenCalled();
  });

  it('Discard and leave goes without writing anything', () => {
    const c = change();
    registerPendingChange('kb', c);
    render(<LeaveDialog />);
    const proceed = ask('kb');
    fireEvent.click(screen.getByRole('button', { name: 'Discard and leave' }));
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(c.commit).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Apply and leave writes the change, and goes once it has landed', async () => {
    const order: string[] = [];
    registerPendingChange(
      'kb',
      change({
        commit: async () => {
          order.push('commit');
          return true;
        },
      }),
    );
    render(<LeaveDialog />);
    const proceed = vi.fn(() => order.push('proceed'));
    act(() => confirmLeave('kb', proceed));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and leave' }));
    });
    expect(order).toEqual(['commit', 'proceed']);
  });

  it('stays when the write fails, so nothing is lost', async () => {
    registerPendingChange('kb', change({ commit: async () => false }));
    render(<LeaveDialog />);
    const proceed = ask('kb');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply and leave' }));
    });
    expect(proceed).not.toHaveBeenCalled();
  });

  it('asks only about the device being left', () => {
    registerPendingChange('mouse', change());
    render(<LeaveDialog />);
    expect(ask('kb')).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('forgets a pane that is gone', () => {
    const off = registerPendingChange('kb', change());
    off();
    render(<LeaveDialog />);
    expect(ask('kb')).toHaveBeenCalledTimes(1);
  });

  it('lists several changes, and offers only to discard them together', () => {
    registerPendingChange('kb', change({ label: 'Lighting effect: Wave' }));
    registerPendingChange('kb', { ...change({ label: 'Per-key colours' }), plural: true });
    render(<LeaveDialog />);
    ask('kb');
    const dialog = screen.getByRole('dialog', { name: 'Leave without applying your changes?' });
    expect(dialog.textContent).toContain(
      "These haven't been applied to the keyboard yet. If you leave now, they're discarded:",
    );
    expect([...dialog.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Lighting effect: Wave',
      'Per-key colours',
    ]);
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and leave']);
  });

  it('agrees with a plural change', () => {
    registerPendingChange('kb', { ...change({ label: 'Per-key colours' }), plural: true });
    render(<LeaveDialog />);
    ask('kb');
    expect(screen.getByRole('dialog').textContent).toContain(
      "Per-key colours haven't been applied to the keyboard yet. If you leave now, they're discarded.",
    );
  });

  it('does not offer to apply to a device that is not answering', () => {
    useStore.setState({ devices: [{ ...KB, online: false } as LiveDevice, MOUSE] });
    registerPendingChange('kb', change());
    render(<LeaveDialog />);
    ask('kb');
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and leave']);
  });

  it('does not offer to apply what cannot be applied from the screen shown', () => {
    registerPendingChange('kb', change({ commit: null }));
    render(<LeaveDialog />);
    ask('kb');
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and leave']);
  });

  it('calls a macro saved, not applied — and saving needs no device', () => {
    useStore.setState({ devices: [KB, { ...MOUSE, online: false } as LiveDevice] });
    registerPendingChange('mouse', change({ kind: 'save', label: 'Combo' }));
    render(<LeaveDialog />);
    ask('mouse');
    const dialog = screen.getByRole('dialog', { name: 'Save this macro before leaving?' });
    expect(dialog.textContent).toContain('“Combo” has changes you never saved.');
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and leave', 'Save and leave']);
  });

  it('says switching profile in its own words', () => {
    registerPendingChange('kb', change());
    render(<LeaveDialog />);
    ask('kb', 'switch');
    const dialog = screen.getByRole('dialog', {
      name: 'Apply this change before switching profile?',
    });
    expect(dialog.textContent).toContain("If you switch now, it's discarded.");
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and switch', 'Apply and switch']);
  });

  it('quitting asks about every device, and says which one each change is on', () => {
    registerPendingChange('kb', change());
    registerPendingChange('mouse', change({ kind: 'save', label: 'Combo' }));
    render(<LeaveDialog />);
    ask(null, 'quit');
    const dialog = screen.getByRole('dialog', { name: 'Quit without applying your changes?' });
    expect([...dialog.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Attack Shark R85HE: Caps Lock → Esc',
      `${MOUSE.displayName}: Macro “Combo”`,
    ]);
    expect(dialogButtons()).toEqual(['Keep editing', 'Discard and quit']);
  });

  it('asks one question at a time, but a quit replaces a leave', () => {
    registerPendingChange('kb', change());
    render(<LeaveDialog />);
    const first = ask('kb');
    const second = ask('kb');
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    const quit = ask(null, 'quit');
    screen.getByRole('dialog', { name: 'Apply this change before quitting?' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard and quit' }));
    expect(quit).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});

describe('quitting the desktop app', () => {
  it('tells the main process whether anything is pending, and answers its quit request', () => {
    const off = installLeaveGuardHost();
    render(<LeaveDialog />);
    const unregister = registerPendingChange('kb', change());
    expect(sdMock.setPendingChanges).toHaveBeenLastCalledWith(true);

    const onQuit = sdMock.on.mock.calls.find(([channel]) => channel === 'app:quitRequested')?.[1];
    expect(onQuit, 'no app:quitRequested listener').toBeTypeOf('function');
    act(() => onQuit());
    // The window comes up on the device holding the change.
    expect(useStore.getState().activeTabId).toBe('device:kb');
    fireEvent.click(screen.getByRole('button', { name: 'Discard and quit' }));
    expect(sdMock.quitApp).toHaveBeenCalledTimes(1);

    unregister();
    expect(sdMock.setPendingChanges).toHaveBeenLastCalledWith(false);
    off();
  });

  it('quits at once when nothing is pending', () => {
    const off = installLeaveGuardHost();
    render(<LeaveDialog />);
    const onQuit = sdMock.on.mock.calls.find(([channel]) => channel === 'app:quitRequested')?.[1];
    act(() => onQuit());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sdMock.quitApp).toHaveBeenCalledTimes(1);
    off();
  });
});
