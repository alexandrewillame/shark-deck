import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { sdMock } from '../../../test/lib/sdStub';
import { bridgeTo, liveDevice, settle } from '../../../test/lib/simDevice';
import { VirtualDriver, virtualDescriptors } from '../../main/devices/virtual';
import { LeaveDialog } from '../components/LeaveDialog';
import { resetLeaveGuard } from '../state/leaveGuard';
import { useStore } from '../state/store';
import { DeviceConfig } from './DeviceConfig';

/**
 * Leaving Remap with a staged pick, end to end: the real menu, the real Remap
 * pane and the real prompt, over the simulated R85HE. Every click is the full
 * pointerdown -> mousedown -> click sequence a browser sends, because the
 * pane drops its key selection — and the pick staged for it — on a
 * pointerdown off the board, before any click handler runs.
 */

const R85HE = virtualDescriptors().find((d) => d.displayName === 'Attack Shark R85HE')!;

function press(el: Element) {
  fireEvent.pointerDown(el, { button: 0 });
  fireEvent.mouseDown(el, { button: 0 });
  fireEvent.pointerUp(el, { button: 0 });
  fireEvent.mouseUp(el, { button: 0 });
  fireEvent.click(el, { button: 0 });
}

const railButton = (name: string) => {
  const b = [...document.querySelectorAll('.tabrail-nav button')].find(
    (el) => el.textContent?.trim() === name,
  );
  expect(b, `no rail button ${name}`).toBeTruthy();
  return b!;
};
const activeSection = () =>
  document.querySelector('.tabrail-nav button.active')?.textContent?.trim();
const boardKey = (label: string) =>
  [...document.querySelectorAll('.kbkey')].find((k) => k.textContent?.trim() === label)!;
const pickerKey = (label: string) =>
  [...document.querySelectorAll('.keeps-selection button')].find(
    (b) => b.textContent?.trim() === label,
  )!;
/** The Remap panel's own Apply — not the prompt's. */
const remapApply = () =>
  [...document.querySelectorAll('.keeps-selection button')].find(
    (b) => b.textContent?.trim() === 'Apply',
  ) as HTMLButtonElement;
const dialogButton = (name: string) => screen.getByRole('button', { name });

async function openRemap(id: string) {
  const device = liveDevice(R85HE, id);
  bridgeTo(
    new VirtualDriver({
      descriptor: { ...R85HE, simulated: true },
      channel: {} as never,
      onWarning: () => undefined,
    }),
  );
  sdMock.setKeyRemap!.mockResolvedValue({ ok: true, verified: 'match' });
  useStore.setState({ devices: [device], activeTabId: `device:${id}` });
  render(
    <>
      <DeviceConfig device={device} />
      <LeaveDialog />
    </>,
  );
  await settle();
  press(railButton('Remap'));
  await settle();
  expect(activeSection()).toBe('Remap');
}

/** Caps Lock -> Esc, staged and not applied. */
async function stageCapsToEsc() {
  press(boardKey('CAPS'));
  await settle();
  press(pickerKey('Esc'));
  await settle();
  expect(remapApply().disabled).toBe(false);
}

beforeEach(() => resetLeaveGuard());

describe('leaving Remap with a staged pick', () => {
  it('goes straight to another section when nothing is staged', async () => {
    await openRemap('r85-none');
    press(boardKey('CAPS'));
    await settle();
    press(railButton('Actuation'));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(activeSection()).toBe('Actuation');
  });

  it('asks first, and Keep editing comes back to the pick as it was', async () => {
    await openRemap('r85-keep');
    await stageCapsToEsc();
    press(railButton('Actuation'));
    await settle();
    const dialog = screen.getByRole('dialog', { name: 'Apply this change before leaving?' });
    expect(dialog.textContent).toContain(
      "Caps Lock → Esc hasn't been applied to the keyboard yet.",
    );

    press(dialogButton('Keep editing'));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(activeSection()).toBe('Remap');
    expect(remapApply().disabled).toBe(false);
    expect(document.querySelector('.remap-staged')?.textContent).toContain('Esc');
    expect(sdMock.setKeyRemap).not.toHaveBeenCalled();
  });

  it('Discard and leave goes, and the pick is gone when you come back', async () => {
    await openRemap('r85-discard');
    await stageCapsToEsc();
    press(railButton('Actuation'));
    await settle();
    press(dialogButton('Discard and leave'));
    await settle();
    expect(activeSection()).toBe('Actuation');

    press(railButton('Remap'));
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(remapApply().disabled).toBe(true);
    expect(sdMock.setKeyRemap).not.toHaveBeenCalled();
  });

  it('Apply and leave writes the remap, then goes', async () => {
    await openRemap('r85-apply');
    await stageCapsToEsc();
    press(railButton('Actuation'));
    await settle();
    await act(async () => {
      press(dialogButton('Apply and leave'));
    });
    await settle();
    expect(sdMock.setKeyRemap).toHaveBeenCalledTimes(1);
    expect(sdMock.setKeyRemap).toHaveBeenCalledWith(
      'r85-apply',
      'base',
      expect.any(Number),
      expect.any(String),
    );
    expect(activeSection()).toBe('Actuation');
  });

  it('asks before the other layer too', async () => {
    await openRemap('r85-layer');
    await stageCapsToEsc();
    const fnLayer = [...document.querySelectorAll('.title-tabs button')].find(
      (b) => b.textContent?.trim() === 'Fn layer',
    )!;
    press(fnLayer);
    await settle();
    press(dialogButton('Keep editing'));
    await settle();
    expect(remapApply().disabled).toBe(false);

    press(fnLayer);
    await settle();
    press(dialogButton('Discard and leave'));
    await settle();
    expect(document.querySelector('.title-tabs button.active')?.textContent?.trim()).toBe(
      'Fn layer',
    );
  });

  it('keeps the pick while another tab is in front, where nothing asks', async () => {
    await openRemap('r85-home');
    await stageCapsToEsc();
    // Home is in front: the device's screen stays mounted behind it, and a
    // click or an Escape there is not about this board.
    act(() => useStore.setState({ activeTabId: 'home' }));
    press(document.body);
    fireEvent.keyDown(window, { key: 'Escape' });
    act(() => useStore.setState({ activeTabId: 'device:r85-home' }));
    await settle();
    expect(remapApply().disabled).toBe(false);
  });
});
