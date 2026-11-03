import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { LiveDevice } from '@shared/types/live';
import { resetSd, sdMock } from '../../../../test/lib/sdStub';
import { ActuationTestSection } from './ActuationTestSection';

/**
 * The Test view when the travel stream does not run.
 *
 * The main process used to answer "ok" to every start without asking the
 * board, and gave up on a board that stopped answering without a word — so
 * none of these three could reach the screen, and each looked like a test
 * running with nobody pressing a key.
 */

const device = {
  id: 'kb',
  ui: { keyMatrix: { layout: [{ label: 'A', row: 0, col: 0, slot: 9, x: 0, y: 0 }] } },
} as unknown as LiveDevice;

/** The view's travel listener, to play the main process with. */
const travel = () =>
  sdMock.on.mock.calls.find(([channel]) => channel === 'device:travel')?.[1] as
    ((p: unknown) => void) | undefined;

const view = () => render(<ActuationTestSection device={device} settings={new Map()} />);
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

beforeEach(() => {
  resetSd();
});

describe('the Test view, when the stream does not run', () => {
  it('says a keyboard with no stream has none, and stops offering Start', async () => {
    sdMock.startTravelStream.mockResolvedValue({ ok: false, unsupported: true, error: 'none' });
    view();
    await screen.findByText('This keyboard has no live travel stream.');
    expect(button('Start test').disabled).toBe(true);
  });

  it('says a start the board refused failed, and lets it be tried again', async () => {
    sdMock.startTravelStream.mockResolvedValue({ ok: false, error: 'write failed' });
    view();
    await screen.findByText(/did not start its live travel stream/);
    expect(button('Start test').disabled).toBe(false);

    sdMock.startTravelStream.mockResolvedValue({ ok: true });
    await userEvent.click(button('Start test'));
    expect(screen.queryByText(/did not start/)).toBeNull();
    expect(button('Stop test')).toBeTruthy();
  });

  it('says so when the stream ends by itself, and withdraws from it', async () => {
    sdMock.startTravelStream.mockResolvedValue({ ok: true });
    view();
    await waitFor(() => expect(travel()).toBeTruthy());
    act(() => travel()!({ id: 'kb', raw: '', keys: [], complete: false, ended: true }));
    await screen.findByText(/stopped answering/);
    expect(button('Start test').disabled).toBe(false);
    expect(sdMock.stopTravelStream).toHaveBeenCalledWith('kb', expect.any(Number));
  });
});
