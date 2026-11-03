import { create } from 'zustand';
import type { AppSettings, PlatformInfo } from '@shared/types/app-settings';
import type { ButtonMapEntry } from '@shared/types/device';
import type { ScanDiagnostic } from '@shared/types/diagnostics';
import type { LiveDevice } from '@shared/types/live';
import type { SwitcherState } from '@shared/types/profiles';
import type { ArtMode, ArtRect } from '../components/ArtAnchor';

export type Route =
  | { name: 'devices' }
  | { name: 'config'; deviceId: string }
  | { name: 'settings' }
  | { name: 'autoswitch' };

/**
 * One open tab. Settings, Auto-Switch and every device each open in their own
 * tab (a second click on an already-open one just focuses it, never
 * duplicates it) — home is the one pinned, unclosable tab, seeded at start.
 */
export interface Tab {
  id: string;
  route: Route;
}

export const HOME_TAB: Tab = { id: 'home', route: { name: 'devices' } };

function tabId(route: Route): string {
  switch (route.name) {
    case 'devices':
      return 'home';
    case 'settings':
      return 'settings';
    case 'autoswitch':
      return 'autoswitch';
    case 'config':
      return `device:${route.deviceId}`;
  }
}

interface Toast {
  id: number;
  kind: 'info' | 'warn' | 'err';
  text: string;
}

/**
 * A wireless-pairing attempt, as observed rather than assumed.
 *
 * - `arming` — the write went out, but the link is still UP: the device has
 *   not been put into pairing mode yet, so there is nothing to wait for.
 * - `searching` — the link has been seen DOWN. This is the only state from
 *   which a completion can be recognised.
 * - `success` — down, then up again. Requiring both halves to be *observed*
 *   is the fix for the original bug: the old loop seeded "I saw it drop" from
 *   the card being offline before the button was even pressed, and then read
 *   a signal (`LiveDevice.online`) that only reports whether the receiver is
 *   plugged in, so it declared success about a second in, every time.
 */
export type PairPhase = 'arming' | 'searching' | 'success' | 'failed' | 'timeout';

export interface PairingRun {
  deviceId: string;
  phase: PairPhase;
  /** Only set with `failed` — the driver's own message. */
  error?: string;
}

/** Give up after this long. The device drops its old link within a second or
 *  two of entering pairing mode, so anything past this is a user who never
 *  got the button combination in. */
const PAIR_TIMEOUT_MS = 45_000;
const PAIR_POLL_MS = 1_000;

/** Is a pairing attempt still running? Exported so every pane can disable its
 *  own button while another device's attempt holds the channel. */
export const pairingBusy = (p: PairingRun | null): boolean =>
  !!p && (p.phase === 'arming' || p.phase === 'searching');

import { sd } from './bridge';

interface UIState {
  tabs: Tab[];
  activeTabId: string;
  devices: LiveDevice[];
  scanDiag: ScanDiagnostic | null;
  switcher: SwitcherState | null;
  settings: AppSettings | null;
  /** OS facts the renderer needs (the ".exe" suffix, native traffic lights,
   *  …) — see PlatformInfo. Null only for the first render, before App's
   *  startup effect resolves it. */
  platformInfo: PlatformInfo | null;
  toasts: Toast[];
  /** Bumped whenever a device's active profile changes (picked in the profile
   *  bar, or applied externally by auto-switch / the device's own physical
   *  button) — DeviceConfig folds this into its tab-pane key so the whole
   *  menu remounts and every section re-reads from the device instead of
   *  going on showing the previous profile's values. Keyed by device id. */
  configEpoch: Record<string, number>;
  bumpConfigEpoch: (deviceId: string) => void;
  /**
   * A slow device operation is in flight for this device — the label is what
   * to show while it runs ("Restoring every key to default", "Switching
   * profile"). `null`/absent means idle.
   *
   * It lives here rather than in the pane that started it because the pane
   * does not survive the operation: a profile switch bumps `configEpoch`,
   * which remounts the whole config menu, and a section that owned the flag
   * in `useState` would lose it halfway through and snap back to looking
   * idle. DeviceConfig reads it and makes the menu inert — see BusyOverlay.
   *
   * Counted, not a boolean, so two overlapping writes cannot have the first
   * one to finish clear the block for both.
   */
  deviceBusy: Record<string, { label: string; depth: number } | undefined>;
  /** Returns the matching `end` — always call it in a `finally`. */
  beginDeviceBusy: (deviceId: string, label: string) => () => void;
  /** The travelling device image. `artFlight` exists for as long as a device
   *  config tab is open and names which device owns the image plus its launch
   *  box (`from` — the clicked card's `.art` rect, so the image visibly lifts
   *  off the card; null for the Ctrl+Tab case where no card was clicked).
   *  `artTarget` is where the image should sit *right now*, republished on
   *  every mount / resize / scroll by whichever <ArtAnchor> is currently
   *  on-screen (a device tab's hero box, or that device's Home card). The one
   *  fixed-position element (components/PersistentDeviceArt.tsx) chases
   *  `artTarget.rect` with a CSS transition — so Home -> device and
   *  device -> Home are the same animation run in reverse. It paints only
   *  while Home or the owning device tab is the active tab; on any other tab
   *  it's `display:none` so it can never get stranded over an unrelated
   *  screen. */
  artFlight: { deviceId: string; from: ArtRect | null; mode: ArtMode; landed: boolean } | null;
  artTarget: { deviceId: string; rect: ArtRect; mode: ArtMode } | null;
  /** Begin (or retarget to a different device) the travelling image. Called
   *  from a Home card the instant it's clicked, with the card's `.art` rect
   *  as the origin, so the image visibly launches from the card. Clears any
   *  stale target so the new flight starts from `from`, not the old box. */
  setArtFlight: (flight: Omit<NonNullable<UIState['artFlight']>, 'landed'> | null) => void;
  /** Report where the travelling image should sit, but only if it currently
   *  belongs to `deviceId` — stops a hidden DeviceConfig or a non-matching
   *  card from hijacking the element. */
  patchArtFlightRect: (deviceId: string, rect: ArtRect, mode: ArtMode) => void;
  /** Flips once the travelling image has settled back onto its Home card (or
   *  is about to move again). Lifted out of PersistentDeviceArt's own local
   *  state so the owning Home card can hide its inline art for exactly the
   *  span the overlay is covering it — otherwise both are visible at once for
   *  the whole return flight. Only applies if `deviceId` still matches the
   *  live flight, same guard as `patchArtFlightRect`. */
  setArtLanded: (deviceId: string, landed: boolean) => void;
  /**
   * The colourway currently being HOVERED in a colour picker, so the hero
   * photo can show it before it is chosen.
   *
   * Same shape of problem as `buttonBadges` below: the photo is one fixed
   * overlay owned by PersistentDeviceArt, mounted once in App, reading the
   * device out of this store — a tab cannot prop-drill into it. The Home
   * card can do this locally because it renders its own small copy; the
   * Device tab's hero box is only an anchor. `null` variant means "hovering
   * nothing", i.e. fall back to the saved colour.
   */
  artColorPreview: { deviceId: string; variant: string | null } | null;
  setArtColorPreview: (deviceId: string, variant: string | null) => void;
  /**
   * The Buttons tab's numbered picker. There is exactly one mouse photo on
   * screen — the same travelling image above, never a second local copy —
   * so the badges have to be drawn *by* PersistentDeviceArt, on top of that
   * one image, rather than by the Buttons tab's own layout (which would be a
   * separate DOM subtree the fixed-position photo can't be reliably
   * out-stacked by, short of hoisting z-index games across unrelated
   * branches of the tree). Set by ButtonsTab while it's mounted (cleared on
   * unmount); `buttonBadgeActive` is the hover link between a badge and its
   * table row, lifted here for the same reason `active` couldn't just stay
   * local to ButtonsTab.
   *
   * Keyed by device id, not a single `{ deviceId, entries }` slot — a
   * device's Buttons tab stays mounted (registered here) for as long as
   * it's the *selected section* of that device's own config screen, which
   * is independent of whether that device's tab is the currently-visible
   * one (switching tabs only toggles `display:none` on `.view`, it doesn't
   * unmount DeviceConfig or its selected section — see App.tsx). With two
   * device tabs open and both showing Buttons, a single shared slot would
   * have the second one's `useEffect` silently clobber the first's the
   * moment it mounts, even while hidden. PersistentDeviceArt only ever
   * reads the entry for whichever device's photo is actually on screen.
   */
  buttonBadges: Record<string, ButtonMapEntry[]>;
  buttonBadgeActive: number | null;
  setButtonBadges: (deviceId: string, entries: ButtonMapEntry[] | null) => void;
  setButtonBadgeActive: (i: number | null) => void;
  /** Focuses a matching open tab, or opens a new one and focuses it. */
  openTab: (route: Route) => void;
  /** No-op for the home tab, which is pinned. */
  closeTab: (id: string) => void;
  /** Closes every open device config tab at once — used when the user
   *  confirms resuming auto-switch while a device menu is open (see
   *  AutoSwitchControl in App.tsx). */
  closeDeviceTabs: () => void;
  /** Moves `dragId` to just before `overId` (or just after it, when `after`
   *  is true — this is what lets a tab land in the very last position,
   *  which "just before" alone can never produce). No-op if either is the
   *  home tab (pinned first, never draggable) or either id isn't an open tab. */
  reorderTab: (dragId: string, overId: string, after?: boolean) => void;
  setDevices: (d: LiveDevice[]) => void;
  setScanDiag: (d: ScanDiagnostic) => void;
  setSwitcher: (s: SwitcherState) => void;
  setSettings: (s: AppSettings) => void;
  setPlatformInfo: (p: PlatformInfo) => void;
  /**
   * The device config tab rail is collapsed because the window is too narrow —
   * as opposed to `settings.railCollapsed`, which is the user's own persisted
   * choice. Deliberately separate and deliberately NOT persisted: a
   * width-driven collapse that wrote `railCollapsed` would overwrite that
   * choice on disk, so a user who once dragged the window narrow would find
   * the rail collapsed forever after. DeviceConfig ORs the two; App owns the
   * single `matchMedia` listener that sets this.
   */
  railAutoCollapsed: boolean;
  setRailAutoCollapsed: (v: boolean) => void;
  toast: (kind: Toast['kind'], text: string) => void;
  dropToast: (id: number) => void;
  /**
   * The one in-flight (or just-finished) pairing attempt. It lives here, not
   * in PairSection, because that pane remounts on every tab switch and every
   * `configEpoch` bump — which used to abandon the run silently and snap the
   * UI back to its idle state while the hardware was still pairing.
   */
  pairing: PairingRun | null;
  runPairing: (deviceId: string) => Promise<void>;
}

let toastSeq = 1;

export const useStore = create<UIState>((set, get) => ({
  tabs: [HOME_TAB],
  activeTabId: HOME_TAB.id,
  devices: [],
  scanDiag: null,
  switcher: null,
  settings: null,
  platformInfo: null,
  toasts: [],
  configEpoch: {},
  bumpConfigEpoch: (deviceId) =>
    set((s) => ({
      configEpoch: { ...s.configEpoch, [deviceId]: (s.configEpoch[deviceId] ?? 0) + 1 },
    })),
  deviceBusy: {},
  beginDeviceBusy: (deviceId, label) => {
    set((s) => ({
      deviceBusy: {
        ...s.deviceBusy,
        [deviceId]: { label, depth: (s.deviceBusy[deviceId]?.depth ?? 0) + 1 },
      },
    }));
    let done = false;
    return () => {
      if (done) return; // an `end` called twice must not unbalance the count
      done = true;
      set((s) => {
        const cur = s.deviceBusy[deviceId];
        if (!cur) return {};
        const next = { ...s.deviceBusy };
        if (cur.depth <= 1) delete next[deviceId];
        else next[deviceId] = { ...cur, depth: cur.depth - 1 };
        return { deviceBusy: next };
      });
    };
  },
  artFlight: null,
  artTarget: null,
  setArtFlight: (flight) =>
    set({ artFlight: flight ? { ...flight, landed: false } : null, artTarget: null }),
  patchArtFlightRect: (deviceId, rect, mode) =>
    set((s) => {
      if (!s.artFlight || s.artFlight.deviceId !== deviceId) return {};
      const t = s.artTarget;
      // No-op when nothing actually changed — a fresh object here would
      // retrigger any effect keyed on `artTarget` for no reason (same class
      // of bug as setArtLanded below).
      if (
        t &&
        t.deviceId === deviceId &&
        t.mode === mode &&
        t.rect.top === rect.top &&
        t.rect.left === rect.left &&
        t.rect.width === rect.width &&
        t.rect.height === rect.height
      ) {
        return {};
      }
      return { artTarget: { deviceId, rect, mode } };
    }),
  artColorPreview: null,
  setArtColorPreview: (deviceId, variant) =>
    set((s) => {
      const cur = s.artColorPreview;
      if (cur?.deviceId === deviceId && cur.variant === variant) return {};
      // `variant: null` while another device is being hovered is not this
      // device's business — a stale clear must not cancel someone else's
      // preview.
      if (variant === null && cur && cur.deviceId !== deviceId) return {};
      return { artColorPreview: variant === null ? null : { deviceId, variant } };
    }),
  setArtLanded: (deviceId, landed) =>
    set((s) => {
      if (!s.artFlight || s.artFlight.deviceId !== deviceId) return {};
      // No-op when the value is unchanged — PersistentDeviceArt's setup
      // effect calls this at the start of every flight, and a fresh object
      // here (even with the same `landed` value) changes `artFlight`'s
      // identity, which is that effect's own dependency: it would tear down
      // and cancel its own in-flight rAFs/timers the instant it started,
      // right before checking whether this was actually a new flight.
      if (s.artFlight.landed === landed) return {};
      return { artFlight: { ...s.artFlight, landed } };
    }),
  buttonBadges: {},
  buttonBadgeActive: null,
  setButtonBadges: (deviceId, entries) =>
    set((s) => {
      if (entries === null) {
        if (!(deviceId in s.buttonBadges)) return {};
        const next = { ...s.buttonBadges };
        delete next[deviceId];
        return { buttonBadges: next };
      }
      return { buttonBadges: { ...s.buttonBadges, [deviceId]: entries } };
    }),
  setButtonBadgeActive: (i) =>
    set((s) => (s.buttonBadgeActive === i ? {} : { buttonBadgeActive: i })),
  openTab: (route) =>
    set((s) => {
      const id = tabId(route);
      if (s.tabs.some((t) => t.id === id)) return { activeTabId: id };
      return { tabs: [...s.tabs, { id, route }], activeTabId: id };
    }),
  closeTab: (id) =>
    set((s) => {
      if (id === HOME_TAB.id) return {};
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return {};
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeTabId =
        s.activeTabId === id ? (tabs[idx - 1] ?? tabs[0] ?? HOME_TAB).id : s.activeTabId;
      // Closing the config tab the travelling image belongs to retires it —
      // the Home card takes its own inline art back.
      const closed = s.tabs[idx]?.route;
      const retire = closed?.name === 'config' && s.artFlight?.deviceId === closed.deviceId;
      const artFlight = retire ? null : s.artFlight;
      const artTarget = retire ? null : s.artTarget;
      return { tabs, activeTabId, artFlight, artTarget };
    }),
  closeDeviceTabs: () =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.route.name !== 'config');
      if (tabs.length === s.tabs.length) return {};
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : HOME_TAB.id;
      return { tabs, activeTabId, artFlight: null, artTarget: null };
    }),
  reorderTab: (dragId, overId, after = false) =>
    set((s) => {
      if (dragId === overId || dragId === HOME_TAB.id || overId === HOME_TAB.id) return {};
      const tabs = [...s.tabs];
      const fromIdx = tabs.findIndex((t) => t.id === dragId);
      if (fromIdx === -1) return {};
      const [moved] = tabs.splice(fromIdx, 1);
      const toIdx = tabs.findIndex((t) => t.id === overId);
      if (toIdx === -1) return {};
      // `+ (after ? 1 : 0)` is what lets a tab land in the very last
      // position — inserting only ever "just before" a target can never
      // produce that, since there's no tab after the last one to be
      // "before" of.
      tabs.splice(toIdx + (after ? 1 : 0), 0, moved!);
      return { tabs };
    }),
  setDevices: (devices) =>
    set((s) => {
      // A device tab stays open while the device is merely offline (still
      // enumerable) — it only closes when the device vanishes from the list
      // entirely (truly unplugged), so the tab doesn't yank itself shut out
      // from under whoever is looking at it.
      const ids = new Set(devices.map((d) => d.id));
      const tabs = s.tabs.filter((t) => t.route.name !== 'config' || ids.has(t.route.deviceId));
      const activeTabId = tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : HOME_TAB.id;
      const gone = s.artFlight && !ids.has(s.artFlight.deviceId);
      const artFlight = gone ? null : s.artFlight;
      const artTarget = gone ? null : s.artTarget;
      return { devices, tabs, activeTabId, artFlight, artTarget };
    }),
  setScanDiag: (scanDiag) => set({ scanDiag }),
  setSwitcher: (switcher) => set({ switcher }),
  setSettings: (settings) => set({ settings }),
  setPlatformInfo: (platformInfo) => set({ platformInfo }),
  railAutoCollapsed: false,
  setRailAutoCollapsed: (railAutoCollapsed) => set({ railAutoCollapsed }),
  toast: (kind, text) =>
    set((s) => {
      const id = toastSeq++;
      setTimeout(() => set((x) => ({ toasts: x.toasts.filter((t) => t.id !== id) })), 6000);
      return { toasts: [...s.toasts, { id, kind, text }] };
    }),
  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  pairing: null,
  runPairing: async (deviceId) => {
    const live = (): PairingRun | null => {
      const p = get().pairing;
      // Anything else took over (another device, or the user reset this pane)
      // — stop, and leave whatever replaced us alone.
      return p && p.deviceId === deviceId && (p.phase === 'arming' || p.phase === 'searching')
        ? p
        : null;
    };
    // One at a time, across devices: there is a single serialized HID channel
    // and a single receiver in pairing mode. `pairingBusy` keeps the other
    // panes' buttons disabled to match.
    if (pairingBusy(get().pairing)) return;

    set({ pairing: { deviceId, phase: 'arming' } });
    const r = await sd.startPairing(deviceId);
    if (!r.ok) {
      set({ pairing: { deviceId, phase: 'failed', error: r.error } });
      return;
    }

    let sawUnlinked = false;
    const deadline = Date.now() + PAIR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, PAIR_POLL_MS));
      if (!live()) return;
      const st = await sd.getPairingStatus(deviceId).catch(() => null);
      if (!live()) return;
      // `null` means the receiver itself did not answer. That is no evidence
      // either way, so it must never count as a drop OR a completion.
      if (!st) continue;
      if (!st.linked) {
        sawUnlinked = true;
        set({ pairing: { deviceId, phase: 'searching' } });
      } else if (sawUnlinked) {
        set({ pairing: { deviceId, phase: 'success' } });
        return;
      }
    }
    set({ pairing: { deviceId, phase: 'timeout' } });
  },
}));
