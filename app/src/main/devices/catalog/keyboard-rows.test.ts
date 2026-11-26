import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEYBOARD_ROWS } from './generated/keyboard-rows';
import { FOREIGN_IDS } from './generated/foreign-ids';
import slugLock from './generated/slugs.lock.json';

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

// Our own Driver v4 extraction, when on this computer (scripts/_raw is
// git-ignored, so CI never has it): the generated rows must say what it says.
const V4 = resolve(process.cwd(), 'scripts/_raw/driverv4/registry.json');
interface V4Row {
  id: number;
  pid: number;
  keyLayout: string | null;
  profiles: number | null;
  magnetic: boolean;
  sideLight: boolean;
  company: string;
  type: string;
}
const v4: V4Row[] = existsSync(V4)
  ? (JSON.parse(readFileSync(V4, 'utf8')) as { rows: V4Row[] }).rows.filter(
      (d) => d.company === 'AttackShark' && d.type === 'keyboard',
    )
  : [];

describe.skipIf(v4.length === 0)('the registry says what Driver v4 says', () => {
  it.each(v4.map((d) => [d.id, d] as const))('id %i', (_id, d) => {
    const r = KEYBOARD_ROWS.find((x) => x.id === d.id);
    expect(r, 'missing from the generated rows').toBeDefined();
    expect([r!.pid, r!.layout, r!.profiles, r!.magnetic, r!.sideLight]).toEqual([
      d.pid,
      d.keyLayout ?? 'Unknown',
      d.profiles ?? 1,
      d.magnetic,
      d.sideLight,
    ]);
  });
});
