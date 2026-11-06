import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The browser edition precaches every file of its build (vite.web.config.ts,
 * the service-worker plugin) so it works offline — the device photos
 * included, since renderer/components/deviceArtAssets.ts bundles the whole of
 * app/assets/devices/. Every photo is downloaded on the first visit, so their
 * total is held to a budget. Over it, the answer is caching photos on first
 * view instead, which changes the service worker's pinned guards
 * (test/contract/no-network-csp.test.ts) — not a bigger budget.
 */
const BUDGET = 8 * 1024 * 1024;
const DIR = resolve(__dirname, '../../assets/devices');

describe('the device photos the browser edition precaches', () => {
  it(`stay within ${BUDGET / 1024 / 1024} MiB`, () => {
    const files = readdirSync(DIR).filter((f) => /\.(webp|png)$/.test(f));
    const total = files.reduce((sum, f) => sum + statSync(resolve(DIR, f)).size, 0);
    expect(files.length).toBeGreaterThan(100);
    expect(
      total,
      `${(total / 1024 / 1024).toFixed(2)} MiB in ${files.length} files`,
    ).toBeLessThanOrEqual(BUDGET);
  });
});
