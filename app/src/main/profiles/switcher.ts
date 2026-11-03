import { EventEmitter } from 'node:events';
import type { WriteResult } from '@shared/types/live';
import {
  type AppProfile,
  type CurrentMode,
  type DeviceProfileLink,
  type ProfileTrigger,
  type SwitchApplication,
  type SwitcherState,
  resolveLink,
} from '@shared/types/profiles';
import { deviceManager } from '../devices/manager';
import { listProfiles, setTriggerIcon } from './store';
import { runningImageNames, pathForRunningExe } from './processScan';
import { iconFor } from './processIcons';

/**
 * How long after leaving a device menu the switcher waits before forcing the
 * current mode back onto every device. Suspension follows the visible tab, so
 * this fires on ordinary navigation — long enough that flicking between tabs
 * doesn't fan out HID writes, short enough to be invisible when someone
 * actually leaves a device menu.
 */
const RESUME_DEBOUNCE_MS = 750;

/**
 * Game-aware profile switching.
 *
 * A profile is a pure LINK: for each device model it names which onboard slot
 * to select, so one game launch can move the mouse to its slot 2 and the
 * keyboard to its slot 1. Applying one is a single SET_PROFILE per device.
 * Trigger process names live on the profile (`AppProfile.triggers`, each
 * independently enable-able), and every non-default profile falls back to the
 * single `isDefault` profile when none of its triggers are running.
 *
 * Three behaviours are load-bearing: poll the process list, act only on
 * TRANSITIONS, and RE-APPLY the desired profile whenever a write fails. That
 * last one is the self-heal after a replug or sleep, and it is the point of
 * the feature.
 *
 * Background, and how this differs from the Python switcher it was generalised
 * from: docs/design/auto-switch.md.
 */
export class Switcher extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private pollMs = 2000;
  /**
   * The tick or converge in flight, if any. One tick awaits disk + a
   * `tasklist` / `ps` child process + a chain of HID writes, which can exceed
   * `pollMs`, and two overlapping passes race on the `applied` map and
   * double-write profiles — a converge (resume, unpin) included: it used to
   * run beside a tick unguarded, so which of the two recorded the switch, and
   * with which reason, came down to timing. See `exclusive`.
   */
  private busy: Promise<void> | null = null;
  private state: SwitcherState = {
    running: false,
    suspended: false,
    activeProfileId: null,
    pinnedProfileId: null,
    lastEvent: null,
    lastSwitch: null,
    applying: null,
    current: null,
  };
  /** last profile id we successfully applied, per device id */
  private applied = new Map<string, string>();
  /** The executable whose presence selected the current profile, and its
   *  icon, so the desktop switch that follows can say what exited. */
  private lastTriggerExe = '';
  private lastTriggerIcon: string | null = null;
  /** Executables already tried once for an icon backfill this session (see
   *  `backfillTriggerIcons`) — a miss (not currently resolvable) isn't
   *  retried every tick; a genuine extraction failure is separately cached
   *  forever by `iconFor()` itself once a path is actually found. */
  private iconAttempted = new Set<string>();
  /**
   * Something was written to a device since suspension began, so what we
   * believe is on each device (`applied`) may be stale and the resume has to
   * force a re-push. Set by `noteDeviceWrite()` from `guardedWrite` in ipc.ts.
   *
   * Suspension now tracks the *visible* tab rather than "a device tab exists",
   * so resuming happens on every navigation away from a device menu instead of
   * once per tab close. Clearing `applied` unconditionally would then re-write
   * the active profile to every device on each flick between tabs; gating it on
   * an actual write keeps the self-heal without the traffic.
   */
  private dirtySinceSuspend = false;
  /** Debounce for the resume-side re-push — see `applySuspension`. */
  private resumeTimer: NodeJS.Timeout | null = null;

  /**
   * The two independent reasons to hold off, ANDed into `state.suspended`.
   *
   * `menuOpen` is the renderer's report that the visible tab is a device
   * menu. `windowVisible` is main's own: closing to tray hides the window but
   * leaves the renderer running with the same tab still "active", so on its
   * own `menuOpen` stayed true forever and the tray menu read PAUSED for a
   * window that was not even on screen — with auto-switch genuinely not
   * running, which is the part that mattered.
   */
  private menuOpen = false;
  private windowVisible = true;

  getState(): SwitcherState {
    return { ...this.state };
  }

  setPollSeconds(sec: number): void {
    this.pollMs = Math.max(1, Number(sec) || 1) * 1000;
    // Just swap the interval — going through `stop()`/`start()` also ran
    // `start()`'s deliberate `pinnedProfileId = null` (an enable-path concern),
    // so changing the poll rate in Settings silently discarded a pinned mode.
    if (this.state.running && !this.state.suspended) {
      this.stopTimer();
      this.startTimer(false);
    }
  }

  start(): void {
    if (this.state.running) return;
    // Starting while a mode is pinned would just poll straight into
    // `tick()`'s pin short-circuit below — auto-switch silently doing
    // nothing at all. The renderer's own enable control confirms this with
    // the user first (see AutoSwitchControl in App.tsx) before calling here;
    // clearing it in one place, rather than at every call site, means the
    // tray's enable menu item — which has no renderer round trip to prompt
    // through — converges the same way for free.
    this.state.pinnedProfileId = null;
    this.state.running = true;
    this.emitState();
    // While a device config tab is open, resuming (see applySuspension) is
    // what actually starts the timer and re-applies — see below. Turning
    // auto-switch on *while already suspended* must still flip `running` and
    // notify (the pill/tray need to read "on, but paused"), just without
    // polling underneath the open menu.
    if (!this.state.suspended) this.startTimer();
  }

  stop(): void {
    this.stopTimer();
    this.state.running = false;
    // Nothing is choosing a mode any more — unless a pin is holding one.
    if (!this.state.pinnedProfileId) this.state.current = null;
    this.emitState();
  }

  /** `immediate` runs one `tick()` right away, same as the old inline
   *  `start()` body did — skipped by `applySuspension`'s resume path, which
   *  runs the equivalent work itself through `converge()` (after its debounce)
   *  and records that pass's own reason. */
  private startTimer(immediate = true): void {
    if (this.timer) return;
    if (immediate) this.tick().catch(() => undefined);
    this.timer = setInterval(() => this.tick().catch(() => undefined), this.pollMs);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A mutating write reached some device — see `guardedWrite` in ipc.ts.
   * Only meaningful while suspended; see `dirtySinceSuspend`.
   */
  noteDeviceWrite(): void {
    if (this.state.suspended) this.dirtySinceSuspend = true;
  }

  /**
   * Called by the renderer whenever the ACTIVE tab becomes (or stops being) a
   * device config menu — see `setSwitcherSuspended` in ipc.ts. Auto-switch
   * holds off while the user is looking at a device's own menu, since `tick()`
   * would otherwise silently overwrite whatever they're editing and yank the
   * profile select out from under them every poll interval. Orthogonal to
   * `running`/`stop()` so the topbar pill can tell "paused because a menu is
   * on screen" apart from "turned off" — see `SwitcherState.suspended`.
   */
  setMenuOpen(open: boolean): void {
    this.menuOpen = open;
    this.applySuspension();
  }

  /**
   * Called by main when the window is shown or hidden. A menu nobody can see
   * is not a menu anybody is editing, so hiding to tray resumes.
   */
  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible;
    this.applySuspension();
  }

  private applySuspension(): void {
    const suspended = this.menuOpen && this.windowVisible;
    if (this.state.suspended === suspended) return;
    this.state.suspended = suspended;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    if (suspended) {
      this.dirtySinceSuspend = false;
      this.stopTimer();
      this.emitState();
      return;
    }
    if (!this.state.running) {
      this.emitState();
      return;
    }
    // Resuming. Go back to polling right away, but hold the forced re-push
    // behind a short debounce: this now fires on every navigation away from a
    // device menu, and flicking between tabs shouldn't fan a burst of HID
    // writes out to every device. A tab flipped back inside the window
    // cancels it (the `clearTimeout` above).
    this.startTimer(false);
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (this.state.suspended || !this.state.running) return;
      // Only forget what we believe is on each device when something actually
      // wrote to one while we were paused — a menu the user only looked at
      // leaves `applied` perfectly valid, and re-pushing over it is pure
      // traffic. The re-push itself is not announced (see `converge`); a game
      // that started or stopped while the menu was open is.
      const forget = this.dirtySinceSuspend;
      this.dirtySinceSuspend = false;
      this.converge(forget).catch(() => undefined);
    }, RESUME_DEBOUNCE_MS);
  }

  async pin(profileId: string | null): Promise<SwitcherState> {
    // Pinning a mode and running auto-switch are mutually exclusive — with
    // both on, `tick()` (below) silently short-circuits on the pin and never
    // reaches game detection, so auto-switch looked "on" while doing nothing.
    // `start()` already clears the pin when auto-switch is (re-)enabled (see
    // above); this is the other direction, so the two controls can't
    // disagree regardless of which one the user touches last.
    if (profileId && this.state.running) this.stop();
    this.state.pinnedProfileId = profileId;
    if (profileId) {
      const p = (await listProfiles()).find((x) => x.id === profileId);
      if (p) {
        this.setCurrent(p, '', null, true);
        // Under the poll's lock: a tick already in flight finishes first,
        // rather than landing its own write on top of this one.
        await this.exclusive(async () => {
          await this.applyProfile(p);
        });
      }
    } else if (!this.state.running) {
      // Unpinned with auto-switch off: nothing holds a mode any more.
      this.state.current = null;
    } else {
      // Unpinning while the switcher is running: converge immediately, and
      // unconditionally. `tick()` alone isn't enough here — it only
      // re-applies the fallback profile when `activeProfileId` *changes*,
      // and pinning never touched `activeProfileId` (it always wrote
      // straight through `applyProfile`, bypassing that bookkeeping) — so a
      // plain `tick()` could see no transition and skip re-applying
      // anything, leaving the device silently stuck on the pinned profile
      // until the next real game-detection transition. A failed process scan
      // just leaves it to the next poll — the unpin itself has happened.
      await this.converge().catch(() => undefined);
    }
    this.emitState();
    return this.getState();
  }

  /**
   * Picks whatever profile should currently be active (first enabled
   * matching trigger, else the default) and re-applies it, unlike `tick()`'s
   * normal path which only re-applies on a detected *transition* of
   * `activeProfileId`. Shared by unpinning (above) and by resuming from a
   * suspend (`applySuspension`) — both need "whatever the current mode is, make
   * sure every device actually has it", regardless of whether
   * `activeProfileId` itself changed.
   *
   * Still goes through `applyProfileIfChanged`'s own per-device `applied`
   * skip — a device already known to hold the target profile isn't rewritten
   * for no reason. `applySuspension`'s resume path gets the "every device,
   * unconditionally" behaviour it wants through `forgetApplied` (below).
   *
   * Which switch it records depends on whether the MODE changed, not on
   * whether anything was written. A game that started (or quit) while a device
   * menu held auto-switch off is a real transition the poll never saw, so it
   * is announced as one — overlay and all — on the way out of the menu. A
   * re-push of the mode that was already in force is not: it is 'manual', and
   * it carries the executable anyway, so nothing reading the switch loses it.
   *
   * Runs under the same lock as `tick()`, waiting for a tick in flight rather
   * than racing it. `forgetApplied` drops what we believe each device holds
   * INSIDE the lock: cleared before waiting, a tick still writing would put
   * its own entry straight back and the forced re-push would skip that device.
   */
  private async converge(forgetApplied = false): Promise<void> {
    await this.exclusive(async () => {
      if (forgetApplied) this.applied.clear();
      const profiles = await listProfiles();
      const procs = await runningImageNames();
      const { match, trigger, target } = this.resolve(profiles, procs);
      const before = this.state.activeProfileId;
      this.state.activeProfileId = match ? match.id : null;
      let reason: SwitchApplication['reason'] = 'manual';
      let exe = '';
      let icon: string | null = null;
      if (match && trigger) {
        exe = trigger.exe;
        icon = trigger.iconDataUrl ?? null;
        this.lastTriggerExe = exe;
        this.lastTriggerIcon = icon;
        if (before !== match.id) {
          reason = 'game';
          this.state.lastEvent = `Game detected: ${match.name}`;
        }
      } else if (before !== null) {
        // Back on the default while we were not looking: say what exited.
        reason = 'desktop';
        exe = this.lastTriggerExe;
        icon = this.lastTriggerIcon;
        this.lastTriggerExe = '';
        this.lastTriggerIcon = null;
        this.state.lastEvent = 'Returned to desktop';
      }
      if (!target) return;
      // Announced before the writes, like `applying` — the mode is decided now.
      this.setCurrent(target, match ? exe : '', match ? icon : null);
      await this.applyProfileIfChanged(target, exe || target.name, reason, icon);
    });
  }

  /**
   * Run one tick or converge, never two at once: waits out whichever is in
   * flight, then claims the slot. The check and the claim happen in the same
   * synchronous step after each wait, so two waiters cannot both get in.
   */
  private async exclusive(run: () => Promise<void>): Promise<void> {
    while (this.busy) await this.busy.catch(() => undefined);
    const pass = run();
    this.busy = pass;
    try {
      await pass;
    } finally {
      if (this.busy === pass) this.busy = null;
    }
  }

  /**
   * Which profile the running processes select: the first non-default profile,
   * in list order, with an enabled trigger that is running — and that trigger
   * — else the default profile. One place, so the poll and `converge` cannot
   * disagree about what is in force.
   */
  private resolve(
    profiles: AppProfile[],
    procs: Set<string>,
  ): { match?: AppProfile; trigger?: ProfileTrigger; target?: AppProfile } {
    for (const p of profiles) {
      if (p.isDefault) continue;
      const trigger = p.triggers.find((tr) => tr.enabled && procs.has(tr.exe.toLowerCase()));
      if (trigger) return { match: p, trigger, target: p };
    }
    return { target: profiles.find((p) => p.isDefault) };
  }

  /**
   * Record the mode in force (`SwitcherState.current`), notifying only when it
   * actually changed — the poll calls this every couple of seconds.
   */
  private setCurrent(
    profile: AppProfile,
    exe: string,
    exeIcon: string | null,
    pinned = false,
  ): void {
    const next: CurrentMode = {
      profileId: profile.id,
      profileName: profile.name,
      isDefault: !!profile.isDefault,
      pinned,
      exe,
      exeIcon,
    };
    const cur = this.state.current;
    if (
      cur &&
      cur.profileId === next.profileId &&
      cur.profileName === next.profileName &&
      cur.isDefault === next.isDefault &&
      cur.pinned === next.pinned &&
      cur.exe === next.exe &&
      cur.exeIcon === next.exeIcon
    )
      return;
    this.state.current = next;
    this.emitState();
  }

  /** consecutive `tickInner()` throws — surfaced after a few so a permanently
   *  failing store/process read doesn't just silently stop auto-switch. */
  private tickFailures = 0;

  private async tick(): Promise<void> {
    // Auto-switch holds off entirely while a device config tab is open (see
    // applySuspension) — the interval is stopped for this too, but tick() stays
    // guarded in case a stray timer fires around the on/off transition.
    if (this.state.suspended) return;
    // A previous tick, or a converge, is still running — skip this one; the
    // next poll comes round soon enough. (A converge waits instead: it is a
    // one-off that must happen.)
    if (this.busy) return;
    try {
      await this.exclusive(() => this.tickInner());
      this.tickFailures = 0;
    } catch (err) {
      this.tickFailures++;
      // Don't spam — one visible note after it's clearly not transient.
      if (this.tickFailures === 3) {
        this.state.lastEvent = `Auto-switch error: ${String((err as Error)?.message ?? err)}`;
        this.emitState();
      }
    }
  }

  private async tickInner(): Promise<void> {
    const profiles = await listProfiles();
    const procs = await runningImageNames();
    // Fire-and-forget: never blocks switching itself, pin or no pin.
    void this.backfillTriggerIcons(profiles, procs);

    if (this.state.pinnedProfileId) {
      const pinned = profiles.find((p) => p.id === this.state.pinnedProfileId);
      if (pinned) {
        this.setCurrent(pinned, '', null, true);
        await this.applyProfileIfChanged(pinned, 'pinned', 'pin');
      }
      return;
    }

    // Stable order: creation/list order, with the default profile excluded
    // from matching (it has no triggers and is the fallback, not a target).
    const { match, trigger, target } = this.resolve(profiles, procs);

    if (match && trigger) {
      if (this.state.activeProfileId !== match.id) {
        this.state.activeProfileId = match.id;
        this.state.lastEvent = `Game detected: ${match.name}`;
        this.emitState();
      }
      // The EXECUTABLE, not the profile name a second time. `context` is what
      // the overlay shows under the mode name, and passing the name meant it
      // read "Gaming" over "Gaming" — the same word twice, saying nothing
      // about why the switch happened.
      this.lastTriggerExe = trigger.exe;
      this.lastTriggerIcon = trigger.iconDataUrl ?? null;
      this.setCurrent(match, trigger.exe, this.lastTriggerIcon);
      await this.applyProfileIfChanged(match, trigger.exe, 'game', this.lastTriggerIcon);
      return;
    }

    // Nothing running matches any profile's triggers: the default profile is
    // in force, whether or not this tick has anything to write for it.
    if (target) this.setCurrent(target, '', null);

    // nothing running matches any profile's triggers -> fall back to the
    // single default profile (there is no per-profile fallback any more).
    if (this.state.activeProfileId !== null) {
      this.state.activeProfileId = null;
      this.state.lastEvent = 'Returned to desktop';
      this.emitState();
      // What stopped running is the useful half of "why am I back on the
      // desktop profile", so carry it through.
      const exited = this.lastTriggerExe;
      const exitedIcon = this.lastTriggerIcon;
      this.lastTriggerExe = '';
      this.lastTriggerIcon = null;
      if (target) await this.applyProfileIfChanged(target, exited, 'desktop', exitedIcon);
    }
  }

  /**
   * A manually-added or scanned Game/App starts out icon-less — there's no
   * file path to extract an icon from until it's actually running. The first
   * time one of `procs` matches an icon-less trigger, resolve its path
   * (scoped by name, not a full process snapshot — see
   * `processScan.pathForRunningExe`), extract its icon, and persist it via
   * `store.setTriggerIcon` so every future render of that row has it, forever
   * — this never re-runs for a trigger once it has an icon *or* once this
   * session has tried and found nothing for it.
   */
  private async backfillTriggerIcons(profiles: AppProfile[], procs: Set<string>): Promise<void> {
    const pending = profiles
      .flatMap((p) => p.triggers)
      .filter(
        (tr) =>
          !tr.iconDataUrl &&
          procs.has(tr.exe.toLowerCase()) &&
          !this.iconAttempted.has(tr.exe.toLowerCase()),
      );
    for (const tr of pending) {
      const exe = tr.exe.toLowerCase();
      this.iconAttempted.add(exe);
      try {
        const path = await pathForRunningExe(exe);
        const icon = path ? await iconFor(path) : null;
        if (!icon) continue;
        await setTriggerIcon(exe, icon);
        this.emit('appProfiles:changed');
      } catch {
        // best-effort — the trigger just stays icon-less
      }
    }
  }

  /**
   * `reason` and `context` feed `state.lastSwitch`, which is what drives the
   * on-screen overlay (main/overlayWindow.ts) — only for `'game'`/`'desktop'`,
   * matching the legacy Python switcher's popup, which only ever fired on a
   * real game transition, never on sign-in, quit, or pinning a profile from
   * the tray/UI. `context` is only meaningful for `'game'` (the matched
   * rule's label); the overlay supplies its own translated wording for the
   * other reasons instead of trusting an English string out of main.
   */
  private async applyProfileIfChanged(
    profile: AppProfile,
    context: string,
    reason: SwitchApplication['reason'],
    exeIcon: string | null = null,
  ): Promise<void> {
    let anyChanged = false;
    const devices: SwitchApplication['devices'] = [];
    // Announced BEFORE the writes, not after: this loop is a burst of feature
    // reports during which the board stops answering promptly, and the UI
    // needs to be able to say so while it is happening.
    const pending = deviceManager
      .list()
      .filter((d) => d.capabilities.includes('profiles') && this.applied.get(d.id) !== profile.id);
    if (pending.length) this.setApplying(profile);
    try {
      for (const dev of pending) {
        const link = resolveLink(profile, dev);
        const ok = await this.applyLinkToDevice(dev.id, link);
        if (ok) {
          this.applied.set(dev.id, profile.id);
          anyChanged = true;
        } else {
          // leave `applied` unset so the next tick retries — self-heal
          this.applied.delete(dev.id);
        }
        devices.push({
          id: dev.id,
          displayName: dev.displayName,
          slot: link.slot,
          ok,
        });
      }
    } finally {
      if (pending.length) this.clearApplying();
    }
    if (anyChanged) {
      this.state.lastEvent = `Applied "${profile.name}" (${context})`;
      this.state.lastSwitch = {
        at: Date.now(),
        profileId: profile.id,
        profileName: profile.name,
        reason,
        // Kept for 'desktop' too — it names the executable that exited,
        // which is exactly what that notification is about.
        context: reason === 'game' || reason === 'desktop' ? context : '',
        exeIcon: reason === 'game' || reason === 'desktop' ? exeIcon : null,
        devices,
      };
      this.emitState();
      // A distinct event from 'switcher:state' (which also fires for
      // running/pinned-id changes with no new switch) — main/index.ts uses
      // this specifically to drive the on-screen overlay.
      this.emit('switcher:applied', this.state.lastSwitch);
    }
  }

  async applyProfile(profile: AppProfile): Promise<WriteResult[]> {
    const results: WriteResult[] = [];
    this.setApplying(profile);
    try {
      for (const dev of deviceManager.list()) {
        if (!dev.capabilities.includes('profiles')) continue;
        const link = resolveLink(profile, dev);
        const ok = await this.applyLinkToDevice(dev.id, link, results);
        if (ok) this.applied.set(dev.id, profile.id);
      }
    } finally {
      this.clearApplying();
    }
    return results;
  }

  private setApplying(profile: AppProfile): void {
    this.state.applying = { profileId: profile.id, profileName: profile.name };
    this.emitState();
  }

  private clearApplying(): void {
    this.state.applying = null;
    this.emitState();
  }

  private async applyLinkToDevice(
    deviceId: string,
    link: DeviceProfileLink,
    sink?: WriteResult[],
  ): Promise<boolean> {
    const driver = deviceManager.getDriver(deviceId);
    if (!driver) return false;
    // One SET_PROFILE. This used to have a second branch that replayed every
    // stored setting block for a `softwareProfiles` device — hundreds of paced
    // feature reports, ~30 s on a keyboard, and it wrote lighting, which is
    // how auto-switch came to stamp a stale global effect over per-key
    // lighting someone had just set. Both keyboard descriptors declare real
    // onboard slots now; see catalog/r85he.ts.
    await deviceManager.ensureBackup(deviceId);
    try {
      const r = await driver.setActiveProfile(link.slot);
      sink?.push(r);
      return r.ok;
    } catch {
      return false;
    }
  }

  private emitState(): void {
    this.emit('switcher:state', this.getState());
  }
}

export const switcher = new Switcher();
