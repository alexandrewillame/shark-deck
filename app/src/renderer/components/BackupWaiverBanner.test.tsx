import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LiveDevice } from '@shared/types/live';

vi.mock('../state/bridge', () => ({ sd: { acknowledgeNoBackup: vi.fn(async () => undefined) } }));

const { BackupWaiverBanner } = await import('./BackupWaiverBanner');

const device = (waiver: LiveDevice['backupWaiver']) =>
  ({ id: 'dev', backupWaiver: waiver }) as unknown as LiveDevice;

describe('BackupWaiverBanner', () => {
  it('names what cannot be backed up', () => {
    render(<BackupWaiverBanner device={device({ unreadable: ['dpi'] })} />);
    expect(screen.getByRole('alert').textContent).toMatch(/cannot hold them: DPI/);
    expect(screen.getByRole('alert').textContent).not.toMatch(/last sent/);
  });

  it('says what the menus show on a mouse that reports nothing', () => {
    render(<BackupWaiverBanner device={device({ unreadable: ['dpi'], writeOnly: true })} />);
    expect(screen.getByRole('alert').textContent).toMatch(/what Shark Deck last sent to it/);
  });

  it('draws nothing once answered', () => {
    const { container } = render(<BackupWaiverBanner device={device(undefined)} />);
    expect(container.textContent).toBe('');
  });
});
