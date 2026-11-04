import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This file is the browser edition: what vite.web.config.ts's __SD_HOST__ makes it.
vi.mock('../state/host', () => ({
  HOST: 'browser',
  hostFeatures: {
    windowChrome: false,
    autoSwitch: false,
    tray: false,
    startAtBoot: false,
    overlay: false,
    mouseSettingsLink: false,
    ambientLighting: false,
    simulatedDevices: false,
    devicePicker: true,
  },
}));

import { sdMock } from '../../../test/lib/sdStub';
import { useStore } from '../state/store';
import { LINUX_ACCESS_COMMANDS, Welcome } from './Welcome';

/** The browser edition's empty state: there is nothing to scan until the user picks a device. */
describe('Welcome, browser edition', () => {
  const withWebHid = (on: boolean) => {
    if (on) Object.defineProperty(navigator, 'hid', { value: {}, configurable: true });
    else Reflect.deleteProperty(navigator, 'hid');
  };

  beforeEach(() => {
    useStore.setState({ scanDiag: null, platformInfo: undefined, toasts: [] });
    withWebHid(true);
  });
  afterEach(() => withWebHid(false));

  it('opens the browser’s device list from the click, instead of claiming to scan', () => {
    sdMock.requestDeviceAccess.mockResolvedValue({ status: 'cancelled' });
    render(<Welcome />);
    expect(screen.queryByText(/Scanning for USB HID devices/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Connect a device/ }));
    expect(sdMock.requestDeviceAccess).toHaveBeenCalledTimes(1);
  });

  it('says so when the browser could not show its list', async () => {
    sdMock.requestDeviceAccess.mockResolvedValue({
      status: 'failed',
      error: 'SecurityError: no user gesture',
    });
    render(<Welcome />);
    fireEvent.click(screen.getByRole('button', { name: /Connect a device/ }));
    await vi.waitFor(() =>
      expect(useStore.getState().toasts.map((t) => t.text)).toEqual([
        expect.stringMatching(/could not show its device list: SecurityError/),
      ]),
    );
  });

  it('explains, without a dead button, a browser that has no WebHID', () => {
    withWebHid(false);
    render(<Welcome />);
    expect(screen.getByText(/This browser cannot reach USB devices/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Connect a device/ })).toBeNull();
  });

  it('hands Linux users the udev rule the desktop packages install', () => {
    useStore.setState({
      platformInfo: {
        os: 'linux',
        processSuffix: '',
        processExample: '',
        canOpenMouseSettings: false,
        nativeTrafficLights: false,
        isDev: false,
        appVersion: '0.0.0',
      },
    });
    render(<Welcome />);
    expect(screen.getByText(/On Linux, allow access once/)).toBeTruthy();
    // The rule itself, from assets/linux/60-sharkdeck.rules — both vendors,
    // none of the file's comments.
    expect(LINUX_ACCESS_COMMANDS).toContain('ATTRS{idVendor}=="3554", TAG+="uaccess"');
    expect(LINUX_ACCESS_COMMANDS).toContain('ATTRS{idVendor}=="3151", TAG+="uaccess"');
    expect(LINUX_ACCESS_COMMANDS).not.toMatch(/^#/m);
    expect(LINUX_ACCESS_COMMANDS).toContain('udevadm trigger');
  });

  it('shows no Linux block elsewhere', () => {
    render(<Welcome />);
    expect(screen.queryByText(/On Linux, allow access once/)).toBeNull();
  });
});
