import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShallow } from 'zustand/react/shallow';
import { useStore, HOME_TAB, type Tab } from './state/store';
import { useT } from './state/i18n';
import { applyTheme, initSystemThemeFeed } from './state/theme';
import { Welcome } from './screens/Welcome';
import { DeviceGrid } from './screens/DeviceGrid';
import { DeviceConfig } from './screens/DeviceConfig';
import { AppSettingsScreen } from './screens/AppSettings';
import { AutoSwitchScreen } from './screens/AutoSwitch';
import { Toasts } from './components/Toasts';
import { PersistentDeviceArt } from './components/PersistentDeviceArt';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BackgroundLayer } from './background/BackgroundLayer';
import { AppearanceMenu } from './components/AppearanceMenu';
import { WindowControls, MinimalWindowControls, Tooltip, ConfirmDialog } from './components/common';
import { LeaveDialog } from './components/LeaveDialog';
import { useAnchoredPosition } from './components/usePortalPosition';
import { moveFocusInList, usePopoverFocus } from './components/usePopoverFocus';
import { requestArtRemeasure } from './components/ArtAnchor';
import { useTabShortcuts } from './state/shortcuts';
import { confirmLeave, installLeaveGuardHost } from './state/leaveGuard';
import { Icon, type IconName } from './components/icons';
import { LOCALES, localeMeta, type TFunc } from '@shared/i18n';
import { deviceName } from './state/ui';
import { useDragOrClick } from './components/useDragOrClick';
import { hostFeatures } from './state/host';

import { sd } from './state/bridge';

export function App() {
  // Selector + shallow-equal, not a bare `useStore()` — otherwise every no-op
  // `set(() => ({}))` in the store (the art-flight rect patches fire one per
  // frame during a flight) creates a fresh top-level state object and
  // re-renders the entire App tree.
  const {
    tabs,
    activeTabId,
    devices,
    openTab,
    closeTab,
    reorderTab,
    setDevices,
    setScanDiag,
    setSwitcher,
    setSettings,
    setPlatformInfo,
    setRailAutoCollapsed,
    toast,
  } = useStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      devices: s.devices,
      openTab: s.openTab,
      closeTab: s.closeTab,
      reorderTab: s.reorderTab,
      setDevices: s.setDevices,
      setScanDiag: s.setScanDiag,
      setSwitcher: s.setSwitcher,
      setSettings: s.setSettings,
      setPlatformInfo: s.setPlatformInfo,
      setRailAutoCollapsed: s.setRailAutoCollapsed,
      toast: s.toast,
    })),
  );
  const platformInfo = useStore((s) => s.platformInfo);

  // Closing a device tab unmounts its whole config screen, staged changes and
  // all, so a change nobody applied is asked about first — see
  // state/leaveGuard.ts. Every close path (the X, middle-click, Ctrl+W) goes
  // through here.
  const closeTabGuarded = (id: string) => {
    const deviceId = id.startsWith('device:') ? id.slice('device:'.length) : null;
    if (deviceId) confirmLeave(deviceId, () => closeTab(id));
    else closeTab(id);
  };
  useTabShortcuts({ closeTab: closeTabGuarded });
  // Quitting (desktop) and closing the page (browser) ask too.
  useEffect(() => installLeaveGuardHost(), []);

  useEffect(() => {
    sd.listDevices().then(setDevices);
    sd.getScanDiagnostic().then(setScanDiag);
    sd.getSwitcherState().then(setSwitcher);
    sd.getSettings().then((s) => {
      setSettings(s);
      applyTheme(s);
    });
    sd.getPlatformInfo().then((info) => {
      setPlatformInfo(info);
      // ⌘/⌥ key wording and shortcuts (state/shortcuts.ts) — any Mac,
      // including the browser edition's.
      document.documentElement.classList.toggle('platform-mac', info.os === 'darwin');
      // Clears the topbar's left edge for macOS's native traffic lights (see
      // main/index.ts's trafficLightPosition, and layout.css). Only the
      // desktop window has them; a Mac browser tab does not.
      document.documentElement.classList.toggle('native-traffic-lights', info.nativeTrafficLights);
    });
    const offTheme = initSystemThemeFeed(() => useStore.getState().settings);

    // macOS full screen hides the traffic lights, and the topbar's inset for
    // them left an empty gap before the brand. Nothing tells the page it is
    // full screen (display-mode stays "browser" in Electron), but then the
    // window covers the whole screen, which a macOS window otherwise cannot —
    // the menu bar stays above it. Only the native-traffic-lights rule reads it.
    const syncFullscreen = () =>
      document.documentElement.classList.toggle(
        'window-fullscreen',
        screen.width > 0 && innerWidth >= screen.width && innerHeight >= screen.height,
      );
    syncFullscreen();
    window.addEventListener('resize', syncFullscreen);

    const offs = [
      offTheme,
      () => window.removeEventListener('resize', syncFullscreen),
      sd.on('devices:changed', (d) => setDevices(d)),
      sd.on('scan:diagnostic', (d) => setScanDiag(d)),
      sd.on('switcher:state', (s) => setSwitcher(s)),
      sd.on('write:warning', (w) => toast('warn', w.message)),
      sd.on('device:battery', () => sd.listDevices().then(setDevices)),
    ];
    return () => offs.forEach((f) => f());
  }, [setDevices, setScanDiag, setSwitcher, setSettings, setPlatformInfo, toast]);

  // Auto-switch holds off while a device config menu is ON SCREEN — otherwise
  // it silently overwrites whatever the user is editing there every poll
  // interval (see SwitcherState.suspended / Switcher.setSuspended in main).
  // The signal is the ACTIVE tab, not "any config tab exists": a device tab
  // left open in the background while the user reads Home is not being edited,
  // and pausing for it meant auto-switch stayed off essentially forever once a
  // device had ever been opened. Recomputed from store state every render
  // rather than tracked at navigation time, so it also self-heals after e.g. a
  // renderer reload. `activeTabId` is the only viable signal here — every tab
  // stays mounted (see the render below), so per-screen mount/unmount hooks
  // never fire on navigation.
  const onDeviceMenu = tabs.find((t) => t.id === activeTabId)?.route.name === 'config';
  useEffect(() => {
    if (!hostFeatures.autoSwitch) return;
    sd.setSwitcherSuspended(onDeviceMenu).then(setSwitcher);
  }, [onDeviceMenu, setSwitcher]);

  // Below this width the device config pane can't fit the Actuation tab's
  // per-key stage (~594px) beside its settings column (~244px) with a 200px
  // rail, a 20px gap and `.content`'s 48px of padding — collapsing the rail
  // hands 144px back and keeps them side by side. Transient and shared by
  // every device tab; the user's own persisted `railCollapsed` is untouched
  // (see UIState.railAutoCollapsed).
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1100px)');
    const apply = (matches: boolean) => {
      setRailAutoCollapsed(matches);
      // The rail's width animates, which moves `.hero-art-col` without
      // resizing it — the one layout change no <ArtAnchor> trigger catches.
      // The manual collapse button does this too; see DeviceConfig.
      requestArtRemeasure();
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [setRailAutoCollapsed]);

  return (
    <div className="app">
      {/* Under everything in `.app` (z-index -1 in its stacking context), and
          never inside `.view` or `.tabpane-in`: both animate a transform, which
          would make a fixed layer fixed to them instead of to the window. */}
      <ErrorBoundary fallback={null}>
        <BackgroundLayer />
      </ErrorBoundary>
      <div
        className="topbar"
        onDoubleClick={(e) => {
          // double-click the drag region (not a button or a tab) toggles maximize
          if (!hostFeatures.windowChrome) return;
          if (!(e.target as HTMLElement).closest('button, .tabstrip-tab'))
            sd.windowToggleMaximize();
        }}
      >
        <ErrorBoundary fallback={null}>
          <BrandHome activeTabId={activeTabId} onGoHome={() => openTab({ name: 'devices' })} />
        </ErrorBoundary>
        <ErrorBoundary fallback={<div className="tabstrip" />}>
          <TabStrip
            tabs={tabs}
            activeTabId={activeTabId}
            devices={devices}
            onSelect={openTab}
            onClose={closeTabGuarded}
            onReorder={reorderTab}
          />
        </ErrorBoundary>
        {hostFeatures.autoSwitch && (
          <ErrorBoundary fallback={null}>
            <AutoSwitchControl onOpen={() => openTab({ name: 'autoswitch' })} />
          </ErrorBoundary>
        )}
        {/* Language first, then appearance: language is the one that changes
            what everything else in the bar SAYS, so it reads before the
            control that only changes how it looks. */}
        <ErrorBoundary fallback={null}>
          <LanguageMenu />
        </ErrorBoundary>
        <ErrorBoundary fallback={null}>
          <AppearanceMenu />
        </ErrorBoundary>
        <SettingsButton onOpen={() => openTab({ name: 'settings' })} />
        {/* macOS draws its own traffic lights (main/index.ts sets
            titleBarStyle: 'hidden' + trafficLightPosition) — a second,
            custom set here would just duplicate them. Before platformInfo
            resolves, navigator.platform answers the same question: defaulting
            to "show them" kept Windows/Linux from flashing without controls,
            but put a Windows-style set on a Mac's first paint, beside the real
            traffic lights, for as long as startup took. */}
        {hostFeatures.windowChrome &&
          !(platformInfo?.nativeTrafficLights ?? /Mac/.test(navigator.platform)) && (
            // Unlike the rest of the topbar, this one keeps the window closable
            // even if it errors — see MinimalWindowControls.
            <ErrorBoundary fallback={<MinimalWindowControls />}>
              <WindowControls />
            </ErrorBoundary>
          )}
      </div>

      <div className="content">
        {/* The one travelling device image — a direct child of `.content` so
            it survives every tab switch, `position: fixed` so it floats over
            whichever view is showing. See PersistentDeviceArt. */}
        <ErrorBoundary fallback={null}>
          <PersistentDeviceArt />
        </ErrorBoundary>
        {tabs.map((tab) => (
          <div key={tab.id} className={`view ${tab.id === activeTabId ? '' : 'view-hidden'}`}>
            <ErrorBoundary>
              <TabContent tab={tab} />
            </ErrorBoundary>
          </div>
        ))}
        <LeaveDialog />
      </div>

      <Toasts />
    </div>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  const devices = useStore((s) => s.devices);
  const route = tab.route;
  if (route.name === 'devices') return devices.length === 0 ? <Welcome /> : <DeviceGrid />;
  if (route.name === 'settings') return <AppSettingsScreen />;
  if (route.name === 'autoswitch') return <AutoSwitchScreen />;
  const device = devices.find((d) => d.id === route.deviceId);
  if (!device) return <Welcome />;
  return <DeviceConfig device={device} />;
}

const DEVICE_ICON: Record<string, IconName> = {
  mouse: 'mouse',
  keyboard: 'keyboard',
  dongle: 'chip',
  unknown: 'chip',
};

function tabMeta(tab: Tab, devices: ReturnType<typeof useStore.getState>['devices'], t: TFunc) {
  const route = tab.route;
  if (route.name === 'devices') return { icon: 'home' as IconName, label: null as string | null };
  if (route.name === 'settings') return { icon: 'gear' as IconName, label: 'settings' };
  if (route.name === 'autoswitch') return { icon: 'bolt' as IconName, label: 'autoswitch' };
  const device = devices.find((d) => d.id === route.deviceId);
  return {
    icon: DEVICE_ICON[device?.kind ?? 'unknown'] ?? 'chip',
    label: device ? deviceName(device, t) : route.deviceId,
  };
}

/**
 * The wordmark and the "back to Home" affordance both do the same thing
 * (navigate to Home), so they're one bordered control rather than two
 * adjacent buttons. On Home itself the return affordance is redundant and
 * hidden; away from Home the control also grows a visible contour so it
 * reads as clickable at a glance (it used to be only the separate arrow
 * button that did this).
 */
function BrandHome({ activeTabId, onGoHome }: { activeTabId: string; onGoHome: () => void }) {
  const t = useT();
  const away = activeTabId !== HOME_TAB.id;
  // Click-and-hold to drag the window (like every other topbar button below
  // except the tabs), and still a plain click to navigate home.
  const drag = useDragOrClick<HTMLButtonElement>(onGoHome);
  return (
    <button className={`brand-group ${away ? 'away' : ''}`} {...drag}>
      <span className="brand-word" role="img" aria-label={t('app.brand')} />
      {away && (
        <span className="brand-home">
          <Icon name="arrowReturn" size={13} />
          {t('app.nav.home')}
        </span>
      )}
    </button>
  );
}

/** The topbar settings gear — split out so it can carry its own
 *  click-and-hold-to-drag behaviour (see useDragOrClick). */
function SettingsButton({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const drag = useDragOrClick<HTMLButtonElement>(onOpen);
  return (
    <Tooltip text={t('app.nav.settings')}>
      <button className="btn topbar-btn icon-only" {...drag}>
        <Icon name="gear" />
      </button>
    </Tooltip>
  );
}

/**
 * The whole pill is the on/off toggle now (previously just a small `Toggle`
 * switch next to it) — reads "ON"/"OFF" instead of a bare switch. The
 * separate icon button that navigates to the Auto-Switch screen moved to the
 * right side, after the state it describes. Both read `switcher.running`
 * from the store, which is already kept live by the `switcher:state`
 * subscription in `App`'s effect — so this, the Auto-Switch screen's own
 * toggle, and the tray menu label all agree for free.
 *
 * A third state, PAUSED (`running && suspended`), covers auto-switch being
 * on but held off because a device config tab is open (see `App`'s
 * `editingDevice` effect and `Switcher.setSuspended` in main) — distinct
 * from both ON and OFF so the user can tell "on, just not acting right now"
 * apart from having turned it off themselves.
 */
function AutoSwitchControl({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const switcher = useStore((s) => s.switcher);
  const setSwitcher = useStore((s) => s.setSwitcher);
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const openTab = useStore((s) => s.openTab);
  const running = switcher?.running ?? false;
  const paused = running && (switcher?.suspended ?? false);
  // Matches the suspension rule in App: the *visible* screen, not "a device
  // tab exists somewhere".
  const onDeviceMenu = tabs.find((tb) => tb.id === activeTabId)?.route.name === 'config';
  // Turning auto-switch on while a mode is pinned silently does nothing —
  // `tick()` short-circuits on the pin and never reaches game detection (see
  // switcher.ts). Warn before flipping it on rather than let the user
  // discover that the hard way; `start()` itself clears the pin once
  // confirmed (see setSwitcherRunning), so the tray's own enable item, which
  // has no renderer round trip to prompt through, still converges.
  const [confirmPinConflict, setConfirmPinConflict] = useState(false);
  // Being *on* a device menu means auto-switch isn't acting either way — it's
  // either off, or on-but-paused (see `paused` above). Clicking the pill there
  // explains the rule (it isn't obvious that navigating away is what resumes
  // it) and offers the one click that fixes it: go back Home. Device tabs stay
  // open — that's the whole point of keying suspension to the visible screen.
  const [confirmResume, setConfirmResume] = useState(false);

  const toggle = () => {
    if (onDeviceMenu) {
      setConfirmResume(true);
      return;
    }
    if (!running && switcher?.pinnedProfileId) {
      setConfirmPinConflict(true);
      return;
    }
    sd.setSwitcherRunning(!running).then(setSwitcher);
  };
  const toggleDrag = useDragOrClick<HTMLButtonElement>(toggle);
  const openDrag = useDragOrClick<HTMLButtonElement>(onOpen);

  // Applying a mode is a burst of feature-report writes during which the
  // board stops answering promptly — the keyboard visibly stalls. Saying so
  // while it happens is the difference between "it's working" and "it froze".
  const applying = switcher?.applying ?? null;

  /**
   * Which mode is actually in force, and what put it there.
   *
   * The control said only ON/OFF/PAUSED, so at a glance there was no way to
   * tell whether the gaming profile or the desktop one was live — the one
   * thing auto-switch exists to decide. `current` carries both the mode name
   * and the executable that selected it, as of the last poll (see
   * switcher.ts). It used to be read off `lastSwitch`, which only changes
   * when something is written — and a re-push after leaving a device menu
   * recorded itself without the executable, so the same running game showed
   * as "Gaming · cs2.exe" one minute and plain "Gaming" the next.
   */
  const current = switcher?.current ?? null;
  // Nothing to say while the fallback is in force. Naming the default
  // profile would put "Desktop" permanently in the topbar, which is the state
  // the control is in almost all of the time and therefore says nothing. The
  // mode only appears when something actually switched you out of it.
  const shown = current && !current.isDefault ? current : null;
  const modeName = applying?.profileName ?? shown?.profileName ?? null;
  const modeExe = shown?.exe ?? '';
  const modeTip = !modeName
    ? null
    : modeExe
      ? t('as.mode.currentWith', { name: modeName, exe: modeExe })
      : t('as.mode.current', { name: modeName });

  const groupClass = applying ? 'applying' : paused ? 'paused' : running ? 'on' : '';
  const iconClass = applying
    ? 'icon-applying'
    : paused
      ? 'icon-paused'
      : running
        ? 'icon-live'
        : '';
  const label = applying
    ? t('as.state.applying')
    : paused
      ? t('as.state.paused')
      : running
        ? t('as.state.on')
        : t('as.state.off');
  const baseTip = applying
    ? t('as.applying.tip', { name: applying.profileName })
    : paused
      ? t('as.toggle.paused')
      : running
        ? t('as.toggle.on')
        : t('as.toggle.off');
  // The mode goes in the tooltip too — the pill next to it is elided on a
  // narrow window, and this is where someone looks to confirm state.
  const tip = running && modeTip ? `${baseTip}\n${modeTip}` : baseTip;

  return (
    <>
      <div className={`autoswitch-group ${groupClass}`}>
        <Tooltip text={tip}>
          {/* The mode readout is INSIDE the toggle, not a sibling of it.
              As its own element it looked clickable, carried a different
              tooltip and stayed un-tinted while the pill around it went red
              or pulsed — three ways of saying it was a separate control when
              it is really part of the same one. */}
          <button
            className="autoswitch-toggle"
            aria-pressed={running}
            aria-busy={applying ? true : undefined}
            {...toggleDrag}
          >
            <Icon name="bolt" size={13} className={iconClass} />
            {label}
            {running && modeName && (
              <span className="autoswitch-mode">
                <span className="autoswitch-mode-name">{modeName}</span>
                {modeExe && <span className="autoswitch-mode-exe">{modeExe}</span>}
              </span>
            )}
          </button>
        </Tooltip>
        <Tooltip text={t('as.optionsTip')}>
          <button className="btn topbar-btn icon-only" {...openDrag}>
            <Icon name="chevronRight" size={13} />
          </button>
        </Tooltip>
      </div>
      {confirmPinConflict && (
        <ConfirmDialog
          title={t('as.pinConflict.title')}
          body={t('as.pinConflict.body')}
          confirmLabel={t('as.pinConflict.confirm')}
          onResolve={(ok) => {
            setConfirmPinConflict(false);
            if (ok) sd.setSwitcherRunning(true).then(setSwitcher);
          }}
        />
      )}
      {confirmResume && (
        <ConfirmDialog
          title={t('as.resume.title')}
          body={t('as.resume.body')}
          confirmLabel={t('as.resume.confirm')}
          onResolve={(ok) => {
            setConfirmResume(false);
            if (!ok) return;
            // Focusing Home flips `onDeviceMenu` false in App's effect, which
            // un-suspends the switcher — this call just makes sure `running`
            // itself is also true (a no-op if it already was, e.g. resuming
            // from PAUSED rather than OFF). `openTab` focuses the existing
            // home tab rather than opening a second one, and every device tab
            // is left exactly where it was.
            openTab({ name: 'devices' });
            sd.setSwitcherRunning(true).then(setSwitcher);
          }}
        />
      )}
    </>
  );
}

/**
 * Lives in the topbar's flexible middle: one tab per open screen — Settings,
 * Auto-Switch and every device each get their own. Home is pinned and
 * unclosable and, since the brand button and the back-to-home button already
 * cover that, it's filtered out of what's *rendered* here — it stays in the
 * underlying `tabs` array (see state/store.ts) so the existing open/close/
 * fallback logic keeps working unmodified. Clicking an already-open target
 * (a device card, the Auto-Switch/Settings buttons) focuses its tab rather
 * than duplicating it (see `openTab` in state/store.ts). Tabs can be
 * reordered by dragging.
 */
function TabStrip({
  tabs,
  activeTabId,
  devices,
  onSelect,
  onClose,
  onReorder,
}: {
  tabs: Tab[];
  activeTabId: string;
  devices: ReturnType<typeof useStore.getState>['devices'];
  onSelect: (route: Tab['route']) => void;
  onClose: (id: string) => void;
  onReorder: (dragId: string, overId: string, after?: boolean) => void;
}) {
  const t = useT();
  const [dragId, setDragId] = useState<string | null>(null);
  // Which tab the drag is currently over, and which side of it — the side is
  // what lets a tab land in the very last position (see store.ts's
  // reorderTab): dropping on the right half of the last tab means "after",
  // not just "before this one".
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  const visible = tabs.filter((tab) => tab.id !== HOME_TAB.id);
  const stripRef = useRef<HTMLDivElement>(null);
  const [underline, setUnderline] = useState<{ left: number; width: number } | null>(null);

  // Slides the active-tab underline instead of letting each tab's own
  // border-bottom snap on/off — one absolutely-positioned element measured
  // against the active tab's actual box, re-measured whenever the active tab,
  // the tab list, or the strip's own width changes (e.g. window resize).
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('.tabstrip-tab.active');
    if (!active) {
      setUnderline(null);
      return;
    }
    const stripRect = strip.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    setUnderline({
      left: activeRect.left - stripRect.left + strip.scrollLeft,
      width: activeRect.width,
    });
  }, [activeTabId, visible.length]);

  return (
    <div
      className="tabstrip"
      ref={stripRef}
      role="tablist"
      // Handlers on the strip itself, guarded to `e.target === e.currentTarget`
      // so they only react to the empty trailing region — a dragover/drop
      // that lands on a tab still hits that tab's own handlers first (event
      // target stays the child there) and is unaffected by these. Without
      // this the space after the last tab (which is also the window drag
      // region) wasn't a drop target at all, so a tab could never become last.
      onDragOver={(e) => {
        if (!dragId || e.target !== e.currentTarget) return;
        e.preventDefault();
        const last = visible[visible.length - 1];
        if (last && last.id !== dragId) setOver({ id: last.id, after: true });
      }}
      onDrop={(e) => {
        if (!dragId || e.target !== e.currentTarget || !over) return;
        e.preventDefault();
        onReorder(dragId, over.id, over.after);
        setDragId(null);
        setOver(null);
      }}
    >
      {underline && (
        <div
          className="tabstrip-underline"
          style={{ left: underline.left, width: underline.width }}
        />
      )}
      {visible.map((tab, index) => {
        const meta = tabMeta(tab, devices, t);
        // On Home no tab here is active, and the strip still needs one stop.
        const tabStop =
          tab.id === activeTabId || (index === 0 && !visible.some((v) => v.id === activeTabId));
        const label =
          meta.label === 'settings'
            ? t('app.nav.settings')
            : meta.label === 'autoswitch'
              ? t('app.nav.autoSwitch')
              : (meta.label ?? t('app.nav.devices'));
        return (
          <div
            key={tab.id}
            className={[
              'tabstrip-tab',
              tab.id === activeTabId ? 'active' : '',
              tab.id === dragId ? 'dragging' : '',
              over?.id === tab.id && tab.id !== dragId
                ? over.after
                  ? 'drag-over-after'
                  : 'drag-over'
                : '',
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onDragStart={(e) => {
              setDragId(tab.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', tab.id);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragId || dragId === tab.id) return;
              // Which half of this tab the pointer is over decides "before"
              // vs "after" — the other half of what lets a tab land last
              // (see the strip-level handler above for the trailing region).
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              setOver({ id: tab.id, after });
            }}
            onDragLeave={() => setOver((o) => (o?.id === tab.id ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              const id = dragId ?? e.dataTransfer.getData('text/plain');
              if (id && id !== tab.id && over) onReorder(id, tab.id, over.after);
              setDragId(null);
              setOver(null);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOver(null);
            }}
            onClick={() => onSelect(tab.route)}
            // A tab for the keyboard too, not only the pointer: the active one
            // is the strip's single stop in the Tab order, arrows move between
            // tabs, Enter or Space opens one. They were bare divs no key could
            // reach — Ctrl+Tab was the only way round.
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={tabStop ? 0 : -1}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(tab.route);
              } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                e.preventDefault();
                const all = [
                  ...(stripRef.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []),
                ];
                const i = all.indexOf(e.currentTarget);
                all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.focus();
              }
            }}
            onAuxClick={(e) => {
              // middle-click anywhere on a tab closes it (store.closeTab
              // no-ops on the pinned Home tab, which isn't rendered here anyway)
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            <Icon name={meta.icon} size={14} />
            <span className="tabstrip-label">{label}</span>
            <button
              className="tabstrip-close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              title={t('common.close')}
              aria-label={`${t('common.close')} ${label}`}
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Icon-only language switcher in the topbar (was a text dropdown in
 * Settings). The list is portaled to `document.body` at `position: fixed`
 * (see usePortalPosition.ts) rather than absolutely positioned inside
 * `.lang-menu` — `.topbar` sets `backdrop-filter`, which creates a CSS
 * stacking context that trapped the list's `z-index` inside it, so a later
 * sibling (`.content`, i.e. the device cards) could paint over it regardless
 * of the z-index value.
 */
function LanguageMenu() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The portaled list lives outside `btnRef`'s DOM subtree, so outside-click
  // detection has to check both — checking only the button would treat every
  // click on a list item as "outside" and close the menu before it registers.
  const listRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(btnRef, listRef, open, { align: 'end', placement: 'bottom' });
  usePopoverFocus(open, !!pos, listRef, btnRef, '[aria-selected="true"]');

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current = settings?.language ?? 'en';
  const drag = useDragOrClick<HTMLButtonElement>(() => setOpen((v) => !v));
  return (
    <div className="lang-menu">
      <Tooltip text={t('set.language')}>
        <button
          ref={btnRef}
          className="btn topbar-btn icon-only"
          aria-haspopup="listbox"
          aria-expanded={open}
          {...drag}
        >
          <Icon name="translate" />
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={listRef}
            className="lang-menu-list"
            role="listbox"
            aria-label={t('set.language')}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
            onKeyDown={(e) => moveFocusInList(e, listRef.current)}
          >
            {LOCALES.map((l) => (
              <button
                key={l.code}
                role="option"
                aria-selected={l.code === current}
                className={`lang-menu-item ${l.code === current ? 'active' : ''}`}
                dir={localeMeta(l.code).dir}
                onClick={async () => {
                  const next = await sd.setSettings({ language: l.code });
                  setSettings(next);
                  setOpen(false);
                }}
              >
                {l.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
