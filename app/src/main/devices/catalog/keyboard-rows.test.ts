import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEYBOARD_ROWS } from './generated/keyboard-rows';
import { FOREIGN_IDS } from './generated/foreign-ids';
import { KEYBOARD_RESOLUTIONS } from './keyboard-resolutions';
import slugLock from './generated/slugs.lock.json';

const V4 = resolve(process.cwd(), 'scripts/_raw/kb-devices.json');

describe('the generated keyboard registry', () => {
  it('has the Attack Shark lineup, one row per model id', () => {
    expect(KEYBOARD_ROWS.length).toBeGreaterThanOrEqual(80);
    expect(new Set(KEYBOARD_ROWS.map((r) => r.id)).size).toBe(KEYBOARD_ROWS.length);
  });

  it('gives every row the slug the lock file pinned', () => {
    // Every per-model store is keyed by slug; a renamed slug orphans a
    // user's profiles, colours and backups.
    for (const r of KEYBOARD_ROWS) {
      expect(r.slug).toBe((slugLock as Record<string, string>)[String(r.id)]);
    }
    expect(new Set(KEYBOARD_ROWS.map((r) => r.slug)).size).toBe(KEYBOARD_ROWS.length);
    expect(KEYBOARD_ROWS.find((r) => r.id === 3123)?.slug).toBe('attack-shark-r85he');
  });

  it('never lists an Attack Shark id among the foreign ones', () => {
    const ours = new Set(KEYBOARD_ROWS.map((r) => r.id));
    expect(FOREIGN_IDS.filter(([id]) => ours.has(id))).toEqual([]);
  });
});

interface V4Device {
  id: number;
  pid: number;
  keyLayout: string | null;
  layer: number | null;
  magnetic: boolean;
  hasSideLight: boolean;
  screen: boolean;
  company: string;
}

// Read only when present: scripts/_raw is git-ignored, so CI never has it, and
// `describe.skipIf` still runs its body to collect the tests.
const v4: V4Device[] = existsSync(V4)
  ? (JSON.parse(readFileSync(V4, 'utf8')) as V4Device[]).filter((d) => d.company === 'AttackShark')
  : [];

describe.skipIf(v4.length === 0)('the registry agrees with our own Driver v4 extraction', () => {
  it.each(v4.map((d) => [d.id, d] as const))('id %i', (_id, d) => {
    const r = KEYBOARD_ROWS.find((x) => x.id === d.id);
    expect(r, 'missing from the generated rows').toBeDefined();
    const fields: [string, unknown, unknown][] = [
      ['pid', d.pid, r!.pid],
      ['layout', d.keyLayout, r!.layout],
      ['profiles', d.layer, r!.profiles],
      ['magnetic', d.magnetic, r!.magnetic],
      ['sideLight', d.hasSideLight, r!.sideLight],
      ['screen', d.screen, r!.screen !== null],
    ];
    for (const [field, a, b] of fields) {
      if (KEYBOARD_RESOLUTIONS[d.id]?.field === field) continue;
      expect(b, `${field}: Driver v4 says ${a}`).toBe(a);
    }
  });
});
