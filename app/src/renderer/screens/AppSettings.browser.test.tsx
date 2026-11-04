import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import type { AppSettings } from '@shared/types/app-settings';
import { useStore } from '../state/store';
import { AppSettingsScreen } from './AppSettings';

const SETTINGS = {
  startAtBoot: false,
  minimizeToTray: true,
  language: 'en',
  palette: 'shark-cyan',
  themeMode: 'dark',
  background: 'none',
  backgroundPalette: true,
  backgroundIntensity: 50,
  pollSeconds: 2,
  overlayEnabled: true,
  batteryLowThreshold: 15,
  railCollapsed: false,
  deviceOrder: [],
  devMode: false,
} as AppSettings;

/** A setting the browser cannot honour must not be offered there at all. */
describe('Settings, browser edition', () => {
  beforeEach(() =>
    useStore.setState({
      settings: SETTINGS,
      platformInfo: {
        os: 'win32',
        processSuffix: '',
        processExample: '',
        canOpenMouseSettings: false,
        nativeTrafficLights: false,
        isDev: true,
        appVersion: '0.1.0',
      },
    }),
  );

  it('offers nothing that needs the desktop app', () => {
    render(<AppSettingsScreen />);
    for (const label of [
      'Start at login',
      'Close to tray',
      'Show profile-switch overlay',
      'System mouse settings',
    ]) {
      expect(screen.queryByText(label), label).toBeNull();
    }
    // Even in a dev build: the browser host never adds simulated devices.
    expect(screen.queryByText(/Simulated devices/i)).toBeNull();
  });

  it('keeps what works in a browser, and says which edition this is', () => {
    render(<AppSettingsScreen />);
    expect(screen.getByText('Low-battery warning at')).toBeTruthy();
    expect(screen.getByText(/This is the browser edition/)).toBeTruthy();
  });
});
