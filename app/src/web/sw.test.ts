import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The service worker's offline lookups (src/web/sw.ts), run against a cache
 * that honours `Vary` the way browsers' Cache Storage does.
 *
 * Found on macOS 26 / Chrome 157 with `npm run preview:web`: Vite's preview
 * server answers with `Vary: Origin`, the browser sends the module script and
 * the stylesheet (`crossorigin` in index.html) with an Origin header, so with
 * the server stopped both missed the cache, fell through to the network and
 * failed — the installed page started blank. The manifest and icons, requested
 * without `crossorigin`, came out of the cache fine.
 */

type Handler = (event: unknown) => void;
type FakeRequest = {
  method: string;
  url: string;
  mode: string;
  headers: { get(name: string): string | null };
};

const SCOPE = 'http://127.0.0.1:4174/';
const SCRIPT = `${SCOPE}assets/index-abc123.js`;
const handlers: Record<string, Handler> = {};
/** url -> what was stored: the request's headers and the response. */
const stored = new Map<string, { reqHeaders: Record<string, string>; res: Response }>();
const g = globalThis as Record<string, unknown>;
const saved = { self: g.self, caches: g.caches, fetch: g.fetch };

function headers(h: Record<string, string>) {
  return { get: (name: string) => h[name.toLowerCase()] ?? null };
}

/** Cache Storage's matching: same URL (query ignored on request), then every
 *  header the response's `Vary` names must be equal on both requests. */
const cache = {
  async addAll() {},
  async match(
    req: string | FakeRequest,
    opts: { ignoreSearch?: boolean; ignoreVary?: boolean } = {},
  ) {
    const url = typeof req === 'string' ? req : req.url;
    const hit = stored.get(opts.ignoreSearch ? url.split('?')[0]! : url);
    if (!hit) return undefined;
    if (!opts.ignoreVary) {
      for (const name of (hit.res.headers.get('vary') ?? '').split(',')) {
        const h = name.trim().toLowerCase();
        if (!h) continue;
        const asked = typeof req === 'string' ? null : req.headers.get(h);
        if (asked !== (hit.reqHeaders[h] ?? null)) return undefined;
      }
    }
    return hit.res;
  },
};

beforeAll(async () => {
  g.self = {
    registration: { scope: SCOPE },
    location: new URL(SCOPE),
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
  };
  g.caches = { open: async () => cache, keys: async () => [], delete: async () => true };
  g.__SD_PRECACHE__ = [];
  g.__SD_BUILD__ = 'test';
  await import('./sw');
});

afterAll(() => {
  Object.assign(g, saved);
  delete g.__SD_PRECACHE__;
  delete g.__SD_BUILD__;
});

function respond(request: FakeRequest): Promise<Response> {
  let pending: Promise<Response> | undefined;
  handlers.fetch!({ request, respondWith: (p: Promise<Response>) => (pending = p) });
  if (!pending) throw new Error('the worker left this request to the network');
  return pending;
}

describe('the service worker offline', () => {
  it("serves a crossorigin request from the cache even when the file was cached with 'Vary: Origin'", async () => {
    // As cache.addAll stored it at install: a request with no Origin header.
    stored.set(SCRIPT, {
      reqHeaders: {},
      res: new Response('code', { headers: { vary: 'Origin' } }),
    });
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    g.fetch = offline;

    // What the browser hands the worker for <script type="module" crossorigin>.
    const res = await respond({
      method: 'GET',
      url: SCRIPT,
      mode: 'cors',
      headers: headers({ origin: SCOPE.slice(0, -1) }),
    });

    expect(await res.text()).toBe('code');
    expect(offline).not.toHaveBeenCalled();
  });

  it('leaves other origins and non-GET requests alone', () => {
    let called = false;
    const event = (request: FakeRequest) => ({ request, respondWith: () => (called = true) });
    handlers.fetch!(
      event({ method: 'GET', url: 'https://example.com/x.js', mode: 'cors', headers: headers({}) }),
    );
    handlers.fetch!(event({ method: 'POST', url: SCRIPT, mode: 'cors', headers: headers({}) }));
    expect(called).toBe(false);
  });
});
