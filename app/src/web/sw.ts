/**
 * The browser edition's service worker: what lets the installed app start
 * with no network at all.
 *
 * Built on its own by vite.web.config.ts (the `serviceWorker` plugin), which
 * prepends the two constants below: every file of the build, and an id that
 * changes whenever any of them does — so a new deploy is a new worker.
 *
 * The rules that matter:
 *  - Same origin, GET only. A request for anywhere else is never touched; the
 *    page's CSP allows none anyway (`connect-src 'none'`).
 *  - Cache first, from one versioned cache filled at install. The network is
 *    only reached for a file of this origin that is not in the build.
 *  - An update never takes over by itself. It waits until the page tells it
 *    to (web/pwa.ts), which happens only when the user chooses to restart and
 *    no device write is in flight — swapping the code under a running write is
 *    exactly what this edition must not do.
 *
 * test/contract/no-network-csp.test.ts exempts this file, and only this file,
 * from its ban on network calls — and pins the same-origin guard below.
 */
export {};

declare const __SD_PRECACHE__: string[];
declare const __SD_BUILD__: string;

interface ExtendableEvent extends Event {
  waitUntil(work: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly registration: { readonly scope: string };
  readonly location: Location;
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', fn: (e: FetchEvent) => void): void;
  addEventListener(type: 'message', fn: (e: MessageEvent) => void): void;
}
declare const self: WorkerScope;

const PREFIX = 'shark-deck-';
const CACHE = `${PREFIX}${__SD_BUILD__}`;
const scope = new URL(self.registration.scope);
/** The one page: every navigation inside the scope gets it. */
const SHELL = new URL('index.html', scope).href;

self.addEventListener('install', (event) => {
  // `cache: 'reload'` skips the HTTP cache: GitHub Pages lets files be cached
  // for ten minutes, and an install that picked up the previous index.html
  // would point at hashed files the new deploy no longer has.
  const files = __SD_PRECACHE__.map((f) => new Request(new URL(f, scope), { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(files)));
  // No skipWaiting() here — see the header: the page decides when.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'activate-update') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // The guard the contract test pins: nothing outside this origin, ever.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // ignoreVary: this cache holds only the build's own files, so a server's
      // `Vary` header has nothing to choose between — and `Vary: Origin` (Vite's
      // preview server sends it, a CORS-enabled host would) made every
      // `crossorigin` request miss: the module script and the stylesheet, which
      // the browser sends with an Origin header. Offline, the page came up blank.
      const hit = await cache.match(request.mode === 'navigate' ? SHELL : request, {
        ignoreSearch: true,
        ignoreVary: true,
      });
      return hit ?? fetch(request);
    })(),
  );
});
