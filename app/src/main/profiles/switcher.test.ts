import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LiveDevice } from '@shared/types/live';
import type { AppProfile, SwitchApplication, SwitcherState } from '@shared/types/profiles';

/**
 * Suspend/resume behaviour of the auto-switcher.
 *
 * This is the half of `Switcher` the UI drives directly: the renderer reports
 * whether a device config menu is the *visible* tab, and the switcher pauses
 * or resumes to match. Two properties matter enough to lock down:
 *
 *  - a user who turned auto-switch OFF is never overridden by navigation, and
 *  - resuming doesn't re-push profiles to every device unless something
 *    actually wrote to one while paused.
 *
 * The second only became load-bearing when suspension moved from "any device
 * tab exists" to "a device menu is on screen": resume now fires on ordinary
 * tab flicks, and an unconditional re-push would put HID writes on every one.
 */

const setActiveProfile = vi.fn(async () => ({ ok: true, verified: 'match' as const }));

const DEVICE: LiveDevice = {
  id: 'dev-1',
  model: 'v8',
  displayName: 'Test Mouse',
  capabilities: ['profiles'],
  online: true,
} as unknown as LiveDevice;

const DESKTOP = {
  id: 'desktop',
  name: 'Desktop',
  isDefault: true,
  triggers: [],
  links: {},
} as unknown as AppProfile;
const GAMING = {
  id: 'gaming',
  name: 'Gaming',
  defaultSlot: 2,
  triggers: [{ exe: 'cs2.exe', enabled: true, iconDataUrl: 'data:image/png;base64,AAAA' }],
  links: {},
} as unknown as AppProfile;

/** What the mocks below answer with — reassigned per test where it matters. */
let profiles: AppProfile[] = [DESKTOP];
let procs = new Set<string>();
/** The process scan failing (a `tasklist` that errors out). */
let scanFails = false;
let devices: LiveDevice[] = [DEVICE];

vi.mock('../devices/manager', () => ({
  deviceManager: {
    list: () => devices,
    getDriver: () => ({ setActiveProfile }),
    ensureBackup: async () => true,
  },
}));
vi.mock('./store', () => ({
  listProfiles: async () => profiles,
  setTriggerIcon: async () => undefined,
}));
vi.mock('./processScan', () => ({
  runningImageNames: async () => {
    if (scanFails) throw new Error('tasklist failed');
    return procs;
  },
  pathForRunningExe: async () => null,
}));
vi.mock('./processIcons', () => ({ iconFor: async () => null }));
vi.mock('./payload', () => ({
  readPayloadFromDevice: async () => ({}),
  writePayloadToDevice: async () => [],
}));

const { Switcher } = await import('./switcher');

/** Long enough to clear RESUME_DEBOUNCE_MS (750) plus the awaits behind it. */
const RESUME_WAIT = 900;

/**
 * `start()` and the resume timer both kick off a promise chain several awaits
 * deep (listProfiles -> runningImageNames -> applyProfileIfChanged ->
 * ensureBackup -> setActiveProfile). Advancing fake timers only drains the
 * microtasks it happens to interleave with, so drain generously afterwards —
 * two `Promise.resolve()`s clears the timer's own continuation but leaves the
 * apply chain mid-flight, which reads as "the resume didn't write" when in
 * fact it hadn't got there yet.
 */
async function settle(ms = 0): Promise<void> {
  if (ms) await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('Switcher suspend/resume', () => {
  let s: InstanceType<typeof Switcher>;

  /**
   * Get the switcher into "running, and it knows the default profile is
   * already on the device" — the state the no-re-push assertions are about.
   *
   * `start()` alone is not enough: `tickInner` applies the default profile
   * only on a *transition* of `activeProfileId`, and the very first tick has
   * it already null, so nothing is applied and `applied` stays empty. A
   * dirty resume runs `converge()`, which has no such guard, and that is what
   * populates it. Leaves the spy cleared.
   */
  async function prime(): Promise<void> {
    s.start();
    await settle();
    s.setMenuOpen(true);
    s.noteDeviceWrite();
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);
    expect(setActiveProfile).toHaveBeenCalled();
    setActiveProfile.mockClear();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    setActiveProfile.mockClear();
    s = new Switcher();
  });

  afterEach(() => {
    s.stop();
    s.setMenuOpen(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("reports suspended without touching the user's own on/off", () => {
    expect(s.getState().running).toBe(false);
    s.setMenuOpen(true);
    expect(s.getState().suspended).toBe(true);
    expect(s.getState().running).toBe(false);

    s.start();
    // on, but paused — the topbar pill's third state
    expect(s.getState().running).toBe(true);
    expect(s.getState().suspended).toBe(true);
  });

  it('stays stopped when resuming while the user has auto-switch off', async () => {
    s.setMenuOpen(true);
    s.noteDeviceWrite();
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);

    expect(s.getState().running).toBe(false);
    // Navigating away from a device menu must never turn auto-switch back on
    // for someone who turned it off themselves.
    expect(setActiveProfile).not.toHaveBeenCalled();
  });

  it('re-pushes the current mode on resume when a device was written to', async () => {
    s.start();
    await settle();
    setActiveProfile.mockClear();

    s.setMenuOpen(true);
    s.noteDeviceWrite(); // the user changed something in the device menu
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);

    expect(setActiveProfile).toHaveBeenCalled();
  });

  it('does not re-push when the device menu was only looked at', async () => {
    await prime();

    s.setMenuOpen(true); // opened a device menu…
    s.setMenuOpen(false); // …and navigated away without changing anything
    await settle(RESUME_WAIT);

    // `applied` still reflects reality, so converge() finds nothing to do.
    expect(setActiveProfile).not.toHaveBeenCalled();
  });

  it('collapses a rapid tab flick into no re-push at all', async () => {
    await prime();

    // Home -> device -> Home -> device, all inside the debounce window: the
    // final state is "suspended", so the pending re-push must be cancelled
    // rather than firing underneath the open menu.
    s.setMenuOpen(true);
    s.noteDeviceWrite();
    s.setMenuOpen(false);
    await settle(100);
    s.setMenuOpen(true);
    await settle(RESUME_WAIT);

    expect(setActiveProfile).not.toHaveBeenCalled();
    expect(s.getState().suspended).toBe(true);
  });

  it('only marks dirty for writes that happen while suspended', async () => {
    await prime();

    s.noteDeviceWrite(); // not suspended — irrelevant
    s.setMenuOpen(true);
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);

    expect(setActiveProfile).not.toHaveBeenCalled();
  });
});
describe('suspension is menu AND window', () => {
  it('resumes when the window is hidden, even with a device menu open', () => {
    const s = new Switcher();
    s.start();
    s.setMenuOpen(true);
    expect(s.getState().suspended).toBe(true);

    // Closing to tray. The renderer keeps running with the same tab active,
    // so `menuOpen` stays true — this is the whole point of the second input.
    s.setWindowVisible(false);
    expect(s.getState().suspended).toBe(false);

    s.setWindowVisible(true);
    expect(s.getState().suspended).toBe(true);
    s.stop();
  });
});

/**
 * What the switcher says is in force, and what it announces.
 *
 * The reported bug: with cs2.exe running throughout, the topbar read
 * "Gaming · cs2.exe" one minute and plain "Gaming" the next. It read the last
 * switch, which only changes when something is written — and the re-push
 * after leaving a device menu recorded itself with no executable, from a pass
 * that also ran unguarded beside the poll, so which one won was timing.
 */
describe('the mode in force', () => {
  let s: InstanceType<typeof Switcher>;
  const applied: SwitchApplication[] = [];
  const states: SwitcherState[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    setActiveProfile.mockClear();
    profiles = [DESKTOP, GAMING];
    procs = new Set();
    devices = [DEVICE];
    applied.length = 0;
    states.length = 0;
    s = new Switcher();
    s.on('switcher:applied', (a: SwitchApplication) => applied.push(a));
    s.on('switcher:state', (st: SwitcherState) => states.push(st));
  });

  afterEach(() => {
    s.stop();
    s.setMenuOpen(false);
    vi.clearAllTimers();
    vi.useRealTimers();
    setActiveProfile.mockImplementation(async () => ({ ok: true, verified: 'match' as const }));
    profiles = [DESKTOP];
    procs = new Set();
    scanFails = false;
    devices = [DEVICE];
  });

  it('names the game behind the mode, before and after a re-push', async () => {
    s.start();
    await settle();
    expect(s.getState().current).toMatchObject({ profileId: 'desktop', isDefault: true, exe: '' });

    procs = new Set(['cs2.exe']);
    await settle(2000);
    expect(s.getState().current).toMatchObject({
      profileId: 'gaming',
      isDefault: false,
      exe: 'cs2.exe',
      exeIcon: 'data:image/png;base64,AAAA',
    });
    expect(applied.map((a) => [a.reason, a.context])).toEqual([['game', 'cs2.exe']]);

    // Edit something in a device menu, leave it: the forced re-push.
    s.setMenuOpen(true);
    s.noteDeviceWrite();
    setActiveProfile.mockClear();
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);
    expect(setActiveProfile).toHaveBeenCalled();
    // Not a new launch — no second popup…
    expect(applied.filter((a) => a.reason === 'game')).toHaveLength(1);
    // …and the mode still says what is running.
    expect(s.getState().current).toMatchObject({ profileId: 'gaming', exe: 'cs2.exe' });
  });

  it('announces a game that started while a device menu was open', async () => {
    s.start();
    await settle();
    s.setMenuOpen(true);
    procs = new Set(['cs2.exe']); // launched while auto-switch held off
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);

    expect(applied.map((a) => [a.reason, a.context])).toEqual([['game', 'cs2.exe']]);
    expect(s.getState().current).toMatchObject({ profileId: 'gaming', exe: 'cs2.exe' });
  });

  it('says what exited when the game quit while a device menu was open', async () => {
    procs = new Set(['cs2.exe']);
    s.start();
    await settle();
    s.setMenuOpen(true);
    procs = new Set();
    s.setMenuOpen(false);
    await settle(RESUME_WAIT);

    expect(applied.map((a) => [a.reason, a.context])).toEqual([
      ['game', 'cs2.exe'],
      ['desktop', 'cs2.exe'],
    ]);
    expect(s.getState().current).toMatchObject({ profileId: 'desktop', exe: '' });
  });

  it('never runs a re-push beside a poll that is still writing', async () => {
    let inFlight = 0;
    let most = 0;
    setActiveProfile.mockImplementation(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1500));
      inFlight--;
      return { ok: true, verified: 'match' as const };
    });
    procs = new Set(['cs2.exe']);
    s.start(); // the first poll starts writing Gaming…
    await settle();
    s.setMenuOpen(true);
    s.noteDeviceWrite();
    s.setMenuOpen(false); // …and the re-push comes due 750 ms in, mid-write
    await settle(RESUME_WAIT);
    await settle(4000);

    expect(setActiveProfile).toHaveBeenCalledTimes(2);
    expect(most).toBe(1);
  });

  it('reports a change of mode even when there is nothing to write', async () => {
    devices = []; // no device that holds profiles
    s.start();
    await settle();
    procs = new Set(['cs2.exe']);
    await settle(2000);

    expect(setActiveProfile).not.toHaveBeenCalled();
    expect(s.getState().lastSwitch).toBeNull();
    expect(states.at(-1)?.current).toMatchObject({ profileId: 'gaming', exe: 'cs2.exe' });
  });

  it('holds a pinned mode, and nothing once off and unpinned', async () => {
    s.start();
    await settle();
    expect(s.getState().current?.profileId).toBe('desktop');
    s.stop();
    expect(s.getState().current).toBeNull();

    await s.pin('gaming');
    expect(s.getState().current).toMatchObject({ profileId: 'gaming', pinned: true, exe: '' });
    await s.pin(null);
    expect(s.getState().current).toBeNull();
  });

  it('takes a failed process scan for nothing, not for every game quitting', async () => {
    procs = new Set(['cs2.exe']);
    s.start();
    await settle();
    scanFails = true;
    await settle(2000);
    await settle(2000);

    expect(applied.map((a) => a.reason)).toEqual(['game']);
    expect(s.getState().current).toMatchObject({ profileId: 'gaming', exe: 'cs2.exe' });
  });
});
