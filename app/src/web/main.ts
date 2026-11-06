/**
 * The browser edition's entry point — vite.web.config.ts builds it into
 * out/web/, which GitHub Pages serves. It stands up inside the page what the
 * Electron main process and the preload do on the desktop (storage, the
 * device manager over WebHID, `window.sharkdeck`), then loads the very same
 * renderer.
 *
 * Out of this edition, by design: everything that needs software installed
 * on the computer — auto-switch, app profiles, the tray, start-at-login.
 */
import { getT, LOCALES } from '@shared/i18n';
import type { MessageKey } from '@shared/i18n';
import { installStorage, paths, readJsonSync } from '../main/store';
import { deviceManager } from '../main/devices/manager';
import { createDeviceHandlers, wireDeviceEvents } from '../main/handlers';
import { getSettingsSync, setSettings } from '../main/settings';
import { browserHandlers, detectOs } from './host/handlers';
import { createBrowserBridge, createEventBus } from './host/bridge';
import { createMemoryKv, openIdbKv } from './host/kv';
import { createWebStorage } from './host/storage-web';
import { registerServiceWorker } from './pwa';
import './web.css';

/** Held for the life of the tab that drives the devices — see `ownDevices`. */
const DEVICE_LOCK = 'shark-deck-devices';

/** The first of the browser's languages Shark Deck speaks. */
function browserLocale(): string {
  const codes = LOCALES.map((l) => l.code);
  for (const lang of navigator.languages ?? [navigator.language]) {
    const exact = codes.find((c) => c.toLowerCase() === lang.toLowerCase());
    if (exact) return exact;
    const base = codes.find((c) => c.toLowerCase() === lang.split('-')[0]!.toLowerCase());
    if (base) return base;
  }
  return 'en';
}

/** A line of text in place of the app, for the cases where it must not start. */
function bootMessage(text: string): void {
  const root = document.getElementById('root')!;
  const p = document.createElement('p');
  p.textContent = text;
  p.style.cssText =
    'max-width:34rem;margin:20vh auto;padding:0 16px;font:15px/1.5 system-ui,sans-serif;color:#c8d3da;text-align:center';
  root.replaceChildren(p);
}

/**
 * Two tabs polling the same device would interleave their frames on the wire
 * (the desktop app serialises everything per device; two tabs cannot). The
 * first tab takes a Web Lock and keeps it until it closes; another one waits
 * here, saying why, and takes over when the first goes away.
 */
async function ownDevices(say: (key: MessageKey) => string): Promise<void> {
  const locks = navigator.locks;
  if (!locks) return;
  const state = await locks.query().catch(() => null);
  if (state?.held?.some((l) => l.name === DEVICE_LOCK)) bootMessage(say('web.boot.otherTab'));
  await new Promise<void>((acquired) => {
    void locks.request(DEVICE_LOCK, () => {
      acquired();
      return new Promise<never>(() => {});
    });
  });
}

async function openStorage() {
  try {
    return await createWebStorage(await openIdbKv());
  } catch (err) {
    // Chromium's private windows still have IndexedDB; this is the rare
    // profile where it will not open at all. Run, but keep nothing.
    console.error('[web] IndexedDB unavailable; app data will not outlive this tab', err);
    return createWebStorage(createMemoryKv());
  }
}

async function boot(): Promise<void> {
  const say = getT(browserLocale());

  // A meta CSP cannot set frame-ancestors and GitHub Pages sends no headers,
  // so a page that frames this one could overlay it and steer clicks into a
  // device write. Refuse to run framed at all.
  if (window.top !== window.self) {
    bootMessage(say('web.boot.framed'));
    return;
  }

  await ownDevices(say);

  installStorage(await openStorage());
  // Ask the browser not to evict app data (backups among it) under pressure.
  void navigator.storage?.persist?.().catch(() => false);
  // A first visit: the browser's language rather than English. The rest of
  // the newcomer's look (Smoke in Shark Cyan) is the shared default
  // (main/settings.ts). A visitor's own choices win from then on.
  if (readJsonSync(paths.settings(), null) === null) {
    await setSettings({ language: browserLocale() });
  }

  deviceManager.configure({
    // The dev server only (`npm run dev:web`): the whole app with simulated
    // devices and no Electron — for visual checks. A published build never
    // offers them (there is no demo mode).
    allowSimulated: import.meta.env.DEV,
    showDevNotes: import.meta.env.DEV,
    os: detectOs(),
    // WebHID exposes no serial numbers — see ManagerConfig.serialless.
    serialless: 'family',
  });

  const bus = createEventBus();
  const bridge = createBrowserBridge(
    // No auto-switcher to tell about writes in this edition.
    { ...createDeviceHandlers({ onDeviceWrite: () => {} }), ...browserHandlers },
    bus,
  );
  window.sharkdeck = bridge.api;
  wireDeviceEvents(bus.push);

  const dark = matchMedia('(prefers-color-scheme: dark)');
  dark.addEventListener('change', (e) => bus.push('nativeTheme:changed', { dark: e.matches }));
  // Plugging in a device that already has permission: list it now, not on the next tick.
  navigator.hid?.addEventListener('connect', () => deviceManager.nudgeScan());
  navigator.hid?.addEventListener('disconnect', () => deviceManager.nudgeScan());
  // A hidden tab's timers are throttled to a second or slower; polling there
  // only stretches each exchange out. Writes in flight still finish.
  document.addEventListener('visibilitychange', () =>
    document.hidden ? deviceManager.pause() : deviceManager.resume(),
  );
  window.addEventListener('beforeunload', (e) => {
    if (bridge.writesInFlight() === 0) return;
    // Closing mid-write can leave a device half-configured. Browsers show
    // their own wording; this only asks them to.
    e.preventDefault();
    e.returnValue = '';
  });

  deviceManager.start();
  if (document.hidden) deviceManager.pause();

  await import('../renderer/main');

  // After the app is up: installing the offline copy must never delay it.
  registerServiceWorker({
    language: () => getSettingsSync().language,
    writesInFlight: bridge.writesInFlight,
  });
}

void boot();
