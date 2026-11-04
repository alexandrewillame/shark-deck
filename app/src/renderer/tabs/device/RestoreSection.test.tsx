import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDevice } from '@shared/types/live';
import { sdMock } from '../../../../test/lib/sdStub';
import { useStore } from '../../state/store';
import { RestoreSection } from './RestoreSection';

/**
 * Backups as files — both editions. Downloading is how a browser user keeps a
 * backup the browser might clear, and how one moves between the desktop app
 * and the browser edition; importing is the way back.
 */
const device = { id: 'kb', model: 'R85HE' } as LiveDevice;
const BACKUP = {
  file: 'R85HE-x-2026.json',
  model: 'R85HE',
  createdAt: 1_700_000_000_000,
  blocks: 3,
};

describe('RestoreSection: backups as files', () => {
  let clicked: { name: string; href: string }[];

  beforeEach(() => {
    useStore.setState({ toasts: [] });
    sdMock.listBackups.mockResolvedValue([BACKUP]);
    clicked = [];
    URL.createObjectURL = vi.fn(() => 'blob:backup');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ name: this.download, href: this.href });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('downloads a backup under its own name', async () => {
    sdMock.exportBackup.mockResolvedValue({ name: BACKUP.file, json: '{"model":"R85HE"}' });
    render(<RestoreSection device={device} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await vi.waitFor(() => expect(clicked).toEqual([{ name: BACKUP.file, href: 'blob:backup' }]));
    expect(sdMock.exportBackup).toHaveBeenCalledWith('kb', BACKUP.file);
  });

  it('says so when a backup cannot be read', async () => {
    sdMock.exportBackup.mockResolvedValue(null);
    render(<RestoreSection device={device} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await vi.waitFor(() =>
      expect(useStore.getState().toasts.map((t) => t.text)).toContain(
        'Could not read that backup.',
      ),
    );
    expect(clicked).toEqual([]);
  });

  it('imports a picked file as one of this device’s backups, and lists it', async () => {
    sdMock.importBackup.mockResolvedValue({ ok: true, info: BACKUP });
    const { container } = render(<RestoreSection device={device} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{"model":"R85HE","blocks":{"a":"b"}}'], 'backup.json', {
      type: 'application/json',
    });
    fireEvent.change(input, { target: { files: [file] } });
    await vi.waitFor(() =>
      expect(sdMock.importBackup).toHaveBeenCalledWith(
        'kb',
        '{"model":"R85HE","blocks":{"a":"b"}}',
      ),
    );
    await vi.waitFor(() =>
      expect(useStore.getState().toasts.map((t) => t.text)).toContain('Backup imported.'),
    );
    expect(sdMock.listBackups).toHaveBeenCalledTimes(2); // the reload after the import
  });

  it('passes on why a file was refused', async () => {
    sdMock.importBackup.mockResolvedValue({ ok: false, error: 'backup is for "V8", not "R85HE"' });
    const { container } = render(<RestoreSection device={device} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['{}'], 'v8.json')] } });
    await vi.waitFor(() =>
      expect(useStore.getState().toasts.map((t) => t.text)).toContain(
        'Could not import that file: backup is for "V8", not "R85HE"',
      ),
    );
  });

  it('does not show the browser-only storage note on the desktop', async () => {
    render(<RestoreSection device={device} />);
    await screen.findByRole('button', { name: 'Download' });
    expect(screen.queryByText(/backups are kept by this browser/)).toBeNull();
  });
});
