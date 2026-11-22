import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LiveDevice } from '@shared/types/live';
import type { SupportPlan } from '@shared/types/device';
import type { PlatformInfo } from '@shared/types/app-settings';
import { MISSING_DEVICE_URL } from '@shared/links';

const sd = vi.hoisted(() => ({
  openReportTool: vi.fn(
    async (): Promise<{ ok: boolean; quitting?: boolean; preview?: boolean }> => ({ ok: true }),
  ),
  openExternal: vi.fn(async () => undefined),
}));
vi.mock('../state/bridge', () => ({ sd }));

const { SupportInvite } = await import('./SupportInvite');
const { useStore } = await import('../state/store');

const device = (support: SupportPlan | undefined, extra: Partial<LiveDevice> = {}) =>
  ({ id: 'dev', kind: 'mouse', ui: { support }, ...extra }) as unknown as LiveDevice;
const on = (os: PlatformInfo['os']) =>
  useStore.setState({ platformInfo: { os } as PlatformInfo, toasts: [] });
const toasts = () => useStore.getState().toasts.map((t) => t.text);

const WHOLE: SupportPlan = { level: 'none', gaps: [], record: 'all' };
const UNKNOWN: SupportPlan = { level: 'none', gaps: [], record: 'report' };
const X8_PRO: SupportPlan = {
  level: 'partial',
  gaps: ['deepSleep', 'macros', 'buttonActions'],
  record: ['deep', 'macro', 'specific'],
};

describe('SupportInvite', () => {
  beforeEach(() => {
    sd.openReportTool.mockClear();
    sd.openReportTool.mockImplementation(async () => ({ ok: true }));
    sd.openExternal.mockClear();
  });

  it('asks before closing Shark Deck on Windows, then starts the tool for this device', async () => {
    on('win32');
    const { container } = render(<SupportInvite device={device(WHOLE)} variant="identity" />);
    // Windows records: nothing about other systems.
    expect(container.textContent).not.toMatch(/Linux|Mac/);
    fireEvent.click(screen.getByText('Record this device'));
    expect(sd.openReportTool).not.toHaveBeenCalled();
    // a dialog of its own, so nothing moves under the pointer
    const dialog = screen.getByRole('dialog', { name: 'Close Shark Deck to record?' });
    expect(dialog.textContent).toMatch(/Shark Deck closes first/);
    fireEvent.click(screen.getByText('Close Shark Deck and start'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
  });

  it('starts nothing when the dialog is cancelled', () => {
    on('win32');
    render(<SupportInvite device={device(WHOLE)} variant="identity" />);
    fireEvent.click(screen.getByText('Record this device'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(sd.openReportTool).not.toHaveBeenCalled();
    expect(screen.getByText('Record this device')).toBeTruthy();
  });

  it('records what is missing on Linux too, closing Shark Deck first', async () => {
    on('linux');
    render(<SupportInvite device={device(X8_PRO)} variant="panel" />);
    expect(
      screen.getByText('Not in Shark Deck yet: deep sleep, macros, some button actions.'),
    ).toBeTruthy();
    expect(screen.getByText(/Windows virtual machine/)).toBeTruthy();
    fireEvent.click(screen.getByText('Record what is missing'));
    expect(sd.openReportTool).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Close Shark Deck and start'));
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
  });

  it('makes the report at once on Linux where a report is all it needs', async () => {
    on('linux');
    render(<SupportInvite device={device(UNKNOWN)} variant="identity" />);
    fireEvent.click(screen.getByText('Make a device report'));
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('tells a Mac what it can do: the report here, the recording on Windows or Linux', async () => {
    on('darwin');
    const { container } = render(<SupportInvite device={device(X8_PRO)} variant="panel" />);
    expect(
      screen.getByText('Not in Shark Deck yet: deep sleep, macros, some button actions.'),
    ).toBeTruthy();
    expect(screen.getByText(/a Mac cannot make one/)).toBeTruthy();
    expect(screen.getByText(/records it on a Windows or Linux computer/)).toBeTruthy();
    // Not the body that says the tool records here.
    expect(container.textContent).not.toContain('can record just these');
    fireEvent.click(screen.getByText('Make a device report'));
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
  });

  it('keeps the report body on a Mac where a report is all it needs', () => {
    on('darwin');
    render(<SupportInvite device={device(UNKNOWN)} variant="identity" />);
    expect(screen.getByText(/A device report is usually enough/)).toBeTruthy();
    expect(screen.queryByText(/a Mac cannot make one/)).toBeNull();
  });

  it('opens the recording tool on the missing steps for a demo device, without closing', async () => {
    on('win32');
    sd.openReportTool.mockImplementation(async () => ({ ok: true, preview: true }));
    render(<SupportInvite device={device(X8_PRO, { simulated: true })} variant="panel" />);
    fireEvent.click(screen.getByText('Record what is missing'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(sd.openReportTool).toHaveBeenCalledWith('dev'));
    expect(sd.openExternal).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(toasts()).toEqual([expect.stringMatching(/steps an owner/)]));
  });

  it('keeps "How it works" on the page, and only it for a demo device with no steps', () => {
    on('win32');
    render(<SupportInvite device={device(UNKNOWN, { simulated: true })} variant="identity" />);
    expect(screen.queryByText('Make a device report')).toBeNull();
    fireEvent.click(screen.getByText('How it works'));
    expect(sd.openExternal).toHaveBeenCalledWith(MISSING_DEVICE_URL);
    expect(sd.openReportTool).not.toHaveBeenCalled();
  });

  it('says why and opens the page when the tool would not start', async () => {
    on('win32');
    sd.openReportTool.mockImplementation(async () => ({ ok: false, error: 'gone' }));
    render(<SupportInvite device={device(X8_PRO, { simulated: true })} variant="panel" />);
    fireEvent.click(screen.getByText('Record what is missing'));
    await vi.waitFor(() => expect(sd.openExternal).toHaveBeenCalledWith(MISSING_DEVICE_URL));
    expect(toasts()).toEqual([expect.stringContaining('gone')]);
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
