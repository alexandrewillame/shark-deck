import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { LiveDevice } from '@shared/types/live';
import type { SupportPlan } from '@shared/types/device';
import { MISSING_DEVICE_URL } from '@shared/links';

/**
 * The invitation in the browser edition, which cannot start a program: one
 * button, "How it works", and a line saying where the tool records — the
 * page cannot know which computer the device report tool will run on.
 */
const sd = vi.hoisted(() => ({
  openReportTool: vi.fn(async () => ({ ok: true })),
  openExternal: vi.fn(async () => undefined),
}));
vi.mock('../state/bridge', () => ({ sd }));
vi.mock('../state/host', async (importOriginal) => {
  const real = await importOriginal<typeof import('../state/host')>();
  return { ...real, hostFeatures: { ...real.hostFeatures, reportTool: false } };
});

const { SupportInvite } = await import('./SupportInvite');

const device = (support: SupportPlan) =>
  ({ id: 'dev', kind: 'mouse', ui: { support } }) as unknown as LiveDevice;

describe('SupportInvite in the browser edition', () => {
  it('offers the page only, and says where the tool records', () => {
    const plan: SupportPlan = { level: 'partial', gaps: ['mediaKeys'], record: ['media'] };
    render(<SupportInvite device={device(plan)} variant="panel" />);
    expect(
      screen.getByText(/records on Windows and Linux; on a Mac it makes the report alone/),
    ).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['How it works']);
    fireEvent.click(screen.getByText('How it works'));
    expect(sd.openExternal).toHaveBeenCalledWith(MISSING_DEVICE_URL);
    expect(sd.openReportTool).not.toHaveBeenCalled();
  });
});
