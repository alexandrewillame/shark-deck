import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './pwa';

/**
 * When the "update ready" banner appears. A fake service-worker container
 * stands in for the browser's (jsdom has none). The case that went wrong on
 * the live page: the browser found the new version while the page was still
 * loading, so it was already installing when `register()` resolved — its
 * `updatefound` had fired before anything listened, and no banner came.
 */
class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing';
  postMessage = vi.fn();
  to(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(() => Promise.resolve());
}

let reg: FakeRegistration;
let container: EventTarget & { controller: object | null; register: () => Promise<unknown> };

const start = async () => {
  registerServiceWorker({ language: () => 'en', writesInFlight: () => 0 });
  await Promise.resolve();
  await Promise.resolve();
};
const banner = () => document.querySelector('.update-banner');

beforeEach(() => {
  vi.stubEnv('DEV', false);
  reg = new FakeRegistration();
  container = Object.assign(new EventTarget(), {
    controller: {} as object | null,
    register: vi.fn(() => Promise.resolve(reg)),
  });
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  banner()?.remove();
});

describe('the update banner', () => {
  it('offers a version that was already downloading when the page started', async () => {
    reg.installing = new FakeWorker();
    await start();
    expect(banner()).toBeNull();
    reg.installing.to('installed');
    expect(banner()).not.toBeNull();
  });

  it('offers a version found while the page is open', async () => {
    await start();
    const incoming = new FakeWorker();
    reg.installing = incoming;
    reg.dispatchEvent(new Event('updatefound'));
    incoming.to('installed');
    expect(banner()).not.toBeNull();
  });

  it('offers a version that was waiting from an earlier visit', async () => {
    reg.waiting = new FakeWorker();
    reg.waiting.state = 'installed';
    await start();
    expect(banner()).not.toBeNull();
  });

  it('stays quiet on the very first install, with nothing to update from', async () => {
    container.controller = null;
    reg.installing = new FakeWorker();
    await start();
    reg.installing.to('installed');
    expect(banner()).toBeNull();
  });

  it('activates the new version only when Restart is clicked', async () => {
    reg.installing = new FakeWorker();
    const incoming = reg.installing;
    await start();
    incoming.to('installed');
    expect(incoming.postMessage).not.toHaveBeenCalled();
    banner()!.querySelector<HTMLButtonElement>('.btn.primary')!.click();
    expect(incoming.postMessage).toHaveBeenCalledWith('activate-update');
  });
});
