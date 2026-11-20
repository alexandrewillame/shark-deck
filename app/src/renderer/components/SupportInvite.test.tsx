import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LiveDevice } from '@shared/types/live';
import type { SupportPlan } from '@shared/types/device';
import type { PlatformInfo } from '@shared/types/app-settings';
import { MISSING_DEVICE_URL } from '@shared/links';

const sd = vi.hoisted(() => ({
  openReportTool: vi.fn(async () => ({ ok: true })),
  openExternal: vi.fn(async () => undefined),
}));
vi.mock('../state/bridge', () => ({ sd }));

const { SupportInvite } = await import('./SupportInvite');
const { useStore } = await import('../state/store');

const device = (support: SupportPlan | undefined, extra: Partial<LiveDevice> = {}) =>
  ({ id: 'dev', kind: 'mouse', ui: { support }, ...extra }) as unknown as LiveDevice;
const on = (os: PlatformInfo['os']) => useStore.setState({ platformInfo: { os } as PlatformInfo });

const WHOLE: SupportPlan = { level: 'none', gaps: [], record: 'all' };
const X8_PRO: SupportPlan = {
  level: 'partial',
  gaps: ['deepSleep', 'macros', 'buttonActions'],
  record: ['deep', 'macro', 'specific'],
};

describe('SupportInvite', () => {
  beforeEach(() => {
    sd.openReportTool.mockClear();
    sd.openExternal.mockClear();
  });

  it('asks before closing Shark Deck on Windows, then starts the tool for this device', async () => {
    on('win32');
    render(<SupportInvite device={device(WHOLE)} variant="identity" />);
    fireEvent.click(screen.getByText('Record this device'));
    expect(sd.openReportTool).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Shark Deck closes first/);
    fireEvent.click(screen.getByText('Close Shark Deck and start'));
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
  });

  it('says what is missing, and makes the report at once on Linux', async () => {
    on('linux');
    render(<SupportInvite device={device(X8_PRO)} variant="panel" />);
    expect(
      screen.getByText('Not in Shark Deck yet: deep sleep, macros, some button actions.'),
    ).toBeTruthy();
    expect(screen.getByText(/recording the official software needs Windows/)).toBeTruthy();
    fireEvent.click(screen.getByText('Make a device report'));
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
  });

  it('opens the "Missing a device?" page for a demo device', () => {
    on('win32');
    render(<SupportInvite device={device(X8_PRO, { simulated: true })} variant="panel" />);
    fireEvent.click(screen.getByText('Record what is missing'));
    expect(sd.openExternal).toHaveBeenCalledWith(MISSING_DEVICE_URL);
    expect(sd.openReportTool).not.toHaveBeenCalled();
  });

  it('leads from the strip above the other tabs to the panel', () => {
    const open = vi.fn();
    const plan: SupportPlan = { level: 'partial', gaps: ['macros'], record: 'specific' };
    render(<SupportInvite device={device(plan)} variant="strip" onOpen={open} />);
    expect(screen.getByText('Not in Shark Deck yet for this mouse: macros.')).toBeTruthy();
    fireEvent.click(screen.getByText('Help add them'));
    expect(open).toHaveBeenCalled();
  });

  it('says nothing about a device that lacks nothing', () => {
    const { container } = render(<SupportInvite device={device(undefined)} variant="panel" />);
    expect(container.textContent).toBe('');
  });
});
