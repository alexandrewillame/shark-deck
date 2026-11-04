import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The live per-key travel stream's refcount and cadence bookkeeping.
 *
 * Two consumers drive the same stream — the Actuation tab's live readout and
 * the calibration overlay — and `stopTravel` used to tear the shared timer
 * down unconditionally, so whichever unmounted first killed the other's feed.
 * Opening calibration with a key already selected is exactly that case, and
 * calibration is also the one consumer that must be able to SLOW the stream:
 * it holds it open for as long as it takes to press every key, at a rate the
 * capture notes say wedges the endpoint when sustained.
 *
 * And the stream's answers. A start resolves with the board's own reply (it
 * used to say "ok" without waiting for one, so a board with no stream looked
 * like one nobody was pressing), and a stream that ends by itself says so
 * rather than going quiet.
 *
 * Same mocked, empty node-hid harness as manager-live.test.ts.
 */

const mockDevicesAsync = vi.fn(async () => [] as unknown[]);
vi.mock('node-hid', () => ({
  default: {
    devicesAsync: (...a: unknown[]) => mockDevicesAsync(...(a as [])),
    HID: class {},
    HIDAsync: { open: vi.fn(async () => ({ close: vi.fn() })) },
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sharkdeck-test', isPackaged: false } }));

const mockSettings = { devMode: true, language: 'en', batteryLowThreshold: 15 };
vi.mock('../settings', () => ({
  getSettingsSync: () => mockSettings,
  getSettings: async () => mockSettings,
  setSettings: async () => mockSettings,
}));
vi.mock('../store', () => ({
  paths: {
    deviceState: () => '/tmp/device-state.json',
    deviceColors: () => '/tmp/device-colors.json',
    onboardProfileNames: () => '/tmp/onboard-names.json',
  },
  readJson: async (_p: string, d: unknown) => d,
  writeJson: async () => {},
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async () => 'f.json',
}));

import type { TravelStreamResult } from '@shared/types/live';
import type { Driver } from './drivers/base';
import { DeviceManager } from './manager';

const scanOnce = (m: DeviceManager) => (m as unknown as { scan(): Promise<void> }).scan();

type Internals = {
  entries: Map<string, { driver: Driver }>;
  travelTimers: Map<string, NodeJS.Timeout>;
  travelRefs: Map<string, number>;
  travelRates: Map<string, number[]>;
  travelRate(id: string): number;
};
const inner = (m: DeviceManager) => m as unknown as Internals;

const LIVE_RATE = 150; // TRAVEL_POLL_MS — the tab's default
const CALIB_RATE = 400; // what CalibrationOverlay asks for

describe('live travel stream: refcount and cadence', () => {
  let mgr: DeviceManager;
  let id: string;

  beforeEach(async () => {
    mockSettings.devMode = true;
    mgr = new DeviceManager();
    mgr.configure({ allowSimulated: true }); // an unpackaged desktop build
    await scanOnce(mgr);
    // Any simulated magnetic keyboard will do; the stream bookkeeping is
    // driver-independent.
    id = mgr.list().find((d) => d.capabilities.includes('magneticSwitches'))!.id;
  });

  afterEach(() => {
    // Leave no interval behind — these tests deliberately open streams that
    // some cases never close.
    for (const d of mgr.list()) mgr.stopTravel(d.id, false, { force: true });
  });

  it('keeps the stream alive while a second consumer still wants it', async () => {
    await mgr.startTravel(id, LIVE_RATE);
    await mgr.startTravel(id, CALIB_RATE);
    expect(inner(mgr).travelRefs.get(id)).toBe(2);

    // The calibration overlay closes; the tab's own readout must survive.
    mgr.stopTravel(id, true, { intervalMs: CALIB_RATE });
    expect(inner(mgr).travelTimers.has(id)).toBe(true);
    expect(inner(mgr).travelRefs.get(id)).toBe(1);

    mgr.stopTravel(id, true, { intervalMs: LIVE_RATE });
    expect(inner(mgr).travelTimers.has(id)).toBe(false);
  });

  it('lets the slowest consumer set the pace, not the fastest', async () => {
    await mgr.startTravel(id, LIVE_RATE);
    expect(inner(mgr).travelRate(id)).toBe(LIVE_RATE);

    // Calibration asking to go easy on the endpoint must actually slow the
    // stream down, even though a faster consumer is already open.
    await mgr.startTravel(id, CALIB_RATE);
    expect(inner(mgr).travelRate(id)).toBe(CALIB_RATE);
  });

  it('restores the faster pace once the slow consumer withdraws', async () => {
    await mgr.startTravel(id, LIVE_RATE);
    await mgr.startTravel(id, CALIB_RATE);
    mgr.stopTravel(id, true, { intervalMs: CALIB_RATE });
    // Withdrawing an arbitrary vote instead of this consumer's own would
    // leave the stream stuck at the calibration rate after calibration ended.
    expect(inner(mgr).travelRate(id)).toBe(LIVE_RATE);
  });

  it('never polls faster than the floor, whatever a caller asks for', async () => {
    await mgr.startTravel(id, 5);
    expect(inner(mgr).travelRate(id)).toBe(LIVE_RATE);
  });

  it('force-stops past the refcount for teardown', async () => {
    await mgr.startTravel(id, LIVE_RATE);
    await mgr.startTravel(id, CALIB_RATE);
    // A device that has gone away must not leave a timer running just
    // because two consumers happened to be open.
    mgr.stopTravel(id, false, { force: true });
    expect(inner(mgr).travelTimers.has(id)).toBe(false);
    expect(inner(mgr).travelRefs.has(id)).toBe(false);
    expect(inner(mgr).travelRates.has(id)).toBe(false);
  });
});

describe('live travel stream: what it answers', () => {
  let mgr: DeviceManager;
  let id: string;
  const driverOf = (deviceId: string) => inner(mgr).entries.get(deviceId)!.driver;
  /** A board whose answer to the arm command is held until the test gives it. */
  const holdStart = (deviceId: string) => {
    let answer!: (r: TravelStreamResult) => void;
    const spy = vi
      .spyOn(driverOf(deviceId), 'startTravelStream')
      .mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    return { spy, answer: (r: TravelStreamResult) => answer(r) };
  };
  const ends = () => {
    const seen: string[] = [];
    mgr.on('device:travel', (p: { id: string; ended?: boolean }) => {
      if (p.ended) seen.push(p.id);
    });
    return seen;
  };

  beforeEach(async () => {
    mockSettings.devMode = true;
    mgr = new DeviceManager();
    mgr.configure({ allowSimulated: true }); // an unpackaged desktop build
    await scanOnce(mgr);
    id = mgr.list().find((d) => d.capabilities.includes('magneticSwitches'))!.id;
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const d of mgr.list()) mgr.stopTravel(d.id, false, { force: true });
  });

  it("passes on a device's refusal, and samples nothing", async () => {
    // A simulated mouse has no stream at all.
    const mouse = mgr.list().find((d) => d.kind === 'mouse')!.id;
    expect(await mgr.startTravel(mouse, LIVE_RATE)).toMatchObject({
      ok: false,
      unsupported: true,
    });
    expect(inner(mgr).travelTimers.has(mouse)).toBe(false);
    // The caller withdraws as it would from a stream that ran, and that balances.
    mgr.stopTravel(mouse, true, { intervalMs: LIVE_RATE });
    expect(inner(mgr).travelRefs.has(mouse)).toBe(false);
  });

  it('starts sampling only once the board has said yes', async () => {
    const board = holdStart(id);
    const started = mgr.startTravel(id, LIVE_RATE);
    expect(inner(mgr).travelTimers.has(id)).toBe(false);
    board.answer({ ok: true });
    expect(await started).toEqual({ ok: true });
    expect(inner(mgr).travelTimers.has(id)).toBe(true);
  });

  it('gives a caller that joins mid-start the same answer, from one arm command', async () => {
    const board = holdStart(id);
    const first = mgr.startTravel(id, LIVE_RATE);
    const second = mgr.startTravel(id, CALIB_RATE);
    board.answer({ ok: false, error: 'refused' });
    expect(await first).toEqual({ ok: false, error: 'refused' });
    expect(await second).toEqual({ ok: false, error: 'refused' });
    expect(board.spy).toHaveBeenCalledTimes(1);
    expect(inner(mgr).travelTimers.has(id)).toBe(false);
  });

  it('does not arm a start that lands after every consumer has left', async () => {
    const board = holdStart(id);
    const started = mgr.startTravel(id, LIVE_RATE);
    mgr.stopTravel(id, true, { intervalMs: LIVE_RATE });
    board.answer({ ok: true });
    await started;
    expect(inner(mgr).travelTimers.has(id)).toBe(false);
  });

  it('says so when it gives up on a board that stopped answering, and keeps the votes', async () => {
    vi.useFakeTimers();
    const driver = driverOf(id);
    vi.spyOn(driver, 'readTravel').mockResolvedValue(null);
    const disable = vi.spyOn(driver, 'stopTravelStream');
    const ended = ends();
    expect(await mgr.startTravel(id, LIVE_RATE)).toEqual({ ok: true });

    await vi.advanceTimersByTimeAsync(LIVE_RATE * 12);
    expect(ended).toEqual([id]);
    expect(inner(mgr).travelTimers.has(id)).toBe(false);
    // The consumer still holds its vote — so a second consumer starting again
    // could not be torn down by this one's late stop — and that stop is what
    // switches the board's report off, once.
    expect(inner(mgr).travelRefs.get(id)).toBe(1);
    expect(disable).not.toHaveBeenCalled();
    mgr.stopTravel(id, true, { intervalMs: LIVE_RATE });
    expect(disable).toHaveBeenCalledTimes(1);
  });

  it('tells consumers a teardown ended the stream, and ignores their late stops', async () => {
    const disable = vi.spyOn(driverOf(id), 'stopTravelStream');
    const ended = ends();
    await mgr.startTravel(id, LIVE_RATE);
    // The channel wedged, say: torn down under a consumer that still wanted it.
    mgr.stopTravel(id, false, { force: true });
    expect(ended).toEqual([id]);
    // Hearing that, the consumer withdraws. Nothing is open, so nothing is sent
    // — to a device that may well be gone.
    mgr.stopTravel(id, true, { intervalMs: LIVE_RATE });
    expect(disable).not.toHaveBeenCalled();
  });
});
