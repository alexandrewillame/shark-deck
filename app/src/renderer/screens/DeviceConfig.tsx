import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LiveDevice } from '@shared/types/live';
import { configTabs } from '../tabs';
import { Tooltip } from '../components/common';
import { Icon } from '../components/icons';
import {
  ArtAnchorContext,
  requestArtRemeasure,
  type ArtMode,
  type ArtRect,
} from '../components/ArtAnchor';
import { ProfileSwitcher } from '../components/ProfileSwitcher';
import {
  BusyOverlay,
  dropDeviceCache,
  prefetchDeviceReads,
  ReadFailureContext,
  useReadFailureRegistry,
} from '../tabs/common';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { confirmLeave } from '../state/leaveGuard';

import { sd } from '../state/bridge';
import { BackupWaiverBanner } from '../components/BackupWaiverBanner';

/**
 * The capability-driven Profile / Buttons / Keys / Actuation / Macros /
 * Lighting / Device tabs (see tabs/index.tsx). Keyed by device id in App.tsx
 * so the active tab resets when you switch devices.
 *
 * Three layout rules to keep in mind when editing this, all explained in
 * docs/design/renderer-layout.md:
 *
 *  - the device photo is ONE node that travels between tabs; each tab marks
 *    where it wants it with <ArtAnchor>, and `mode="keyboard"` hides it in
 *    place on the panes that own an interactive board;
 *  - the rail is `position: sticky` and splits its nav from its collapse
 *    footer, each with its own scroll region. Do not merge them;
 *  - when the device drops offline every control is disabled by a wrapping
 *    `<fieldset>`, and the banner sits OUTSIDE it so it can never itself go
 *    inert.
 */
export function DeviceConfig({ device }: { device: LiveDevice }) {
  const t = useT();
  const tabs = useMemo(() => configTabs(device), [device]);
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const artFlightId = useStore((s) => s.artFlight?.deviceId ?? null);
  const activeTabId = useStore((s) => s.activeTabId);
  const setArtFlight = useStore((s) => s.setArtFlight);
  const patchArtFlightRect = useStore((s) => s.patchArtFlightRect);
  // Two independent reasons the rail can be narrow: the user asked for it
  // (persisted), or the window is too narrow to afford 200px of labels
  // (transient, owned by App's matchMedia listener). Either collapses it.
  const railAutoCollapsed = useStore((s) => s.railAutoCollapsed);
  const setRailAutoCollapsed = useStore((s) => s.setRailAutoCollapsed);
  const collapsed = (settings?.railCollapsed ?? false) || railAutoCollapsed;
  const configEpoch = useStore((s) => s.configEpoch[device.id] ?? 0);
  const bumpConfigEpoch = useStore((s) => s.bumpConfigEpoch);
  // A slow write is in flight (see useDeviceBusy). Everything below goes
  // inert until it returns — the rail especially: leaving for another section
  // mid-write remounts it into a read that is racing the write.
  const busy = useStore((s) => s.deviceBusy[device.id]);

  // A profile switch caused *outside* this menu (auto-switch pushing a mode,
  // or the device's own physical profile/DPI button) still lands here via the
  // manager's poll -> devices:changed -> activeProfile — bump the epoch the
  // same way the in-menu switcher does, so the config pane picks it up too.
  // Guarded to a genuine change after the first render so mounting the menu
  // doesn't immediately remount itself.
  //
  // Only a pane the slot actually changes is remounted. On a keyboard that is
  // Actuation alone (TabDef.profileScoped): remounting Lighting or Remap for a
  // press of the board's profile button re-read the same values and threw
  // away whatever the user had not applied yet — a per-key layout mid-edit,
  // with its undo history.
  const lastActiveProfile = useRef(device.activeProfile);
  const activeScoped = useRef(false);
  activeScoped.current = !!tabs.find((tb) => tb.id === active)?.profileScoped;
  useEffect(() => {
    if (lastActiveProfile.current !== device.activeProfile) {
      lastActiveProfile.current = device.activeProfile;
      // Every cached read describes the profile that was active when it was
      // taken — a switch replaces the whole per-profile block, so the cache is
      // now describing the wrong one. Drop it BEFORE the epoch bump remounts
      // the panes, so they re-read rather than seeding from stale values.
      dropDeviceCache(device.id);
      if (activeScoped.current) bumpConfigEpoch(device.id);
    }
  }, [device.activeProfile, device.id, bumpConfigEpoch]);

  // Nothing cached is worth keeping for a device that has gone: it may come
  // back changed, and it may come back as a different endpoint entirely (the
  // V8 has both a dongle and a USB-C identity).
  useEffect(() => {
    if (!device.online) dropDeviceCache(device.id);
  }, [device.online, device.id]);

  // Arm the DPI/poll-rate poll for exactly as long as this device's screen is
  // the one on show. Keyed on `activeTabId`, NOT on mount: every device tab
  // stays mounted (App.tsx hides rather than unmounts), so a mount-scoped
  // watch would leave every device ever opened being polled — the same trap
  // the auto-switch suspension comment in App.tsx documents.
  const watched = activeTabId === `device:${device.id}`;
  useEffect(() => {
    if (!watched) return;
    void sd.setLiveWatch(device.id, true);
    return () => void sd.setLiveWatch(device.id, false);
  }, [watched, device.id]);

  // Read everything the other tabs will want while the user is still looking
  // at the first one, so switching tabs shows values instead of a spinner.
  // See prefetchDeviceReads. Gated on the device being here and on screen —
  // there is nothing to gain from talking to a device nobody is looking at,
  // and `device.online` keeps it off a device that is not answering anyway.
  // Joined, not the array itself: `device` is rebuilt on every battery and
  // live-state poll, so the array's identity changes ~every 2.5s and would
  // restart the prefetch each time.
  // `configEpoch` is in here for the same reason the panes remount on it: a
  // profile switch drops the whole cache, and prefetchDeviceReads skips
  // anything already cached. Without the epoch this effect never re-runs, so
  // the warm-up sat out exactly the moment it is most needed and every tab
  // after the switched-to one opened on a cold multi-page read.
  // `activeProfile` too: a switch drops the cache even when it does not bump
  // the epoch (the pane on show was not profile-scoped, see above).
  const capsKey = device.capabilities.join(',');
  useEffect(() => {
    if (!watched || !device.online) return;
    return prefetchDeviceReads(device);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched, device.online, device.id, capsKey, configEpoch, device.activeProfile]);

  useEffect(() => {
    if (!tabs.some((t2) => t2.id === active)) setActive(tabs[0]?.id ?? '');
  }, [tabs, active]);

  // Claim the travelling image for this device whenever this tab is the
  // active one and doesn't already own it — covers Ctrl+Tab-ing straight to
  // a second already-open device tab, where there was no card click to seed
  // the flight. `from` is null (no launch box); the first <ArtAnchor> below
  // fills in the target and the image fades in there.
  useEffect(() => {
    if (activeTabId === `device:${device.id}` && artFlightId !== device.id) {
      setArtFlight({ deviceId: device.id, from: null, mode: 'hero' });
    }
  }, [activeTabId, artFlightId, device.id, setArtFlight]);

  const reportArt = useCallback(
    (rect: ArtRect, m: ArtMode) => patchArtFlightRect(device.id, rect, m),
    [device.id, patchArtFlightRect],
  );

  const activeTab = tabs.find((tb) => tb.id === active);
  const Comp = activeTab?.component;

  // One "Re-read" for the whole menu instead of one per section that
  // couldn't read from the device — see tabs/common.tsx's ReadFailureContext.
  // Registrations reset on tab switch (or a profile switch — see
  // configEpoch above) since the provider is inside the `key={active}:
  // {configEpoch}` remounting div below.
  const { registry, failedCount, reloadAll } = useReadFailureRegistry();

  // Switching section remounts the pane below (the `key` on `.tabpane-in`), so
  // a change nobody applied is asked about first — see state/leaveGuard.ts.
  const goToTab = (id: string) => {
    if (busy || id === active) return;
    confirmLeave(device.id, () => setActive(id));
  };

  // Slides a single indicator to the active rail button instead of each
  // button's own inset box-shadow snapping on/off. Measured against the
  // button's rect relative to .tabrail-nav (its scroll container), so it
  // stays correct whether the nav list itself is scrolled.
  const navRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const activeBtn = nav.querySelector<HTMLElement>('button.active');
    if (!activeBtn) {
      setIndicator(null);
      return;
    }
    setIndicator({ top: activeBtn.offsetTop, height: activeBtn.offsetHeight });
  }, [active, collapsed, tabs.length]);

  return (
    <div className={`config ${collapsed ? 'rail-collapsed' : ''}`}>
      {/* Above the rail as well as the pane — see BusyOverlay. Rendered as a
          child of `.config` (which is already `position: relative`) so one
          scrim covers both grid columns. */}
      {busy && <BusyOverlay label={busy.label} />}
      <div className="tabrail">
        <div className="tabrail-nav" ref={navRef}>
          {indicator && (
            <div
              className="tabrail-indicator"
              style={{ top: indicator.top, height: indicator.height }}
            />
          )}
          {tabs.map((tb) => (
            <Tooltip
              key={tb.id}
              text={collapsed ? `${t(tb.labelKey)} — ${t(tb.descKey)}` : t(tb.descKey)}
            >
              <button
                className={tb.id === active ? 'active' : ''}
                disabled={!!busy}
                onClick={() => goToTab(tb.id)}
              >
                <Icon name={tb.icon} />
                <span className="rail-label">{t(tb.labelKey)}</span>
              </button>
            </Tooltip>
          ))}
        </div>
        {/* Pinned at the very bottom of the rail, below the nav list. Same
            metrics as a nav button (see .tabrail-collapse in styles.css) so
            it reads as one more rail item, and its label collapses with the
            same .rail-label transition. */}
        {/* Icon only — the tooltip carries the "Collapse" / "Expand" label. The
            button keeps its full-width box (padding unchanged) so the rail
            footer doesn't shift. */}
        <Tooltip text={collapsed ? t('cfg.rail.expand') : t('cfg.rail.collapse')}>
          <button
            className="tabrail-collapse"
            onClick={() => {
              // The rail's width animates, which moves `.hero-art-col` without
              // resizing it — the one layout change no <ArtAnchor> trigger
              // catches, so the travelling photo used to sit at its old x until
              // the next scroll. See requestArtRemeasure.
              requestArtRemeasure();
              // Expanding has to clear the width-driven collapse too, or the
              // button would appear dead on a narrow window: `collapsed` is the
              // OR of both, so writing railCollapsed:false alone changes
              // nothing visible. The auto flag re-arms on the next crossing of
              // the breakpoint.
              if (collapsed) setRailAutoCollapsed(false);
              void sd.setSettings({ railCollapsed: !collapsed }).then(setSettings);
            }}
            aria-pressed={collapsed}
            aria-label={collapsed ? t('cfg.rail.expand') : t('cfg.rail.collapse')}
          >
            <Icon name="panelCollapse" />
          </button>
        </Tooltip>
      </div>
      <div className="config-content">
        {/* Each tab declares whether a profile switch changes anything on it
            (see TabDef.profileScoped in tabs/index.tsx). The Device tab is the
            long-standing case — firmware, pairing and backups apply to the
            hardware, not to a slot — but it is not the only one, and a list of
            exceptions kept here meant a new tab inherited "yes" by default. */}
        {tabs.find((tb) => tb.id === active)?.profileScoped && <ProfileSwitcher device={device} />}
        <ArtAnchorContext.Provider value={reportArt}>
          <ReadFailureContext.Provider value={registry}>
            <div key={`${active}:${configEpoch}`} className="tabpane-in offline-host">
              {!device.online && (
                <div className="offline-banner">
                  <Tooltip text={t('cfg.offline.tip')}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Icon name="warning" />
                      {t('cfg.offline.banner')}
                    </span>
                  </Tooltip>
                </div>
              )}
              <BackupWaiverBanner device={device} />
              {device.online && failedCount > 0 && (
                <div className="readfail-banner">
                  <span>{t('cfg.readFailed')}</span>
                  <button className="btn" onClick={reloadAll}>
                    {t('cfg.reread')}
                  </button>
                </div>
              )}
              <fieldset
                className="offline-lock"
                disabled={!device.online || !!busy || !!device.backupWaiver}
              >
                {Comp && <Comp device={device} />}
              </fieldset>
            </div>
          </ReadFailureContext.Provider>
        </ArtAnchorContext.Provider>
      </div>
    </div>
  );
}
