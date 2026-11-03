import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT, interfaceMembers, objectProps, parse } from '../lib/ast';

/**
 * CLAUDE.md invariant #1: a full backup exists on disk before the first write
 * to any device. Every mutating IPC handler goes through `guardedWrite()` in
 * src/main/ipc.ts, which calls `deviceManager.ensureBackup()` and refuses the
 * write if no backup could be taken.
 *
 * "Mutating" is deliberately NOT a hand-kept list -- it is read off the AST as
 * the `Api` methods returning `Promise<WriteResult>` or `Promise<WriteResult[]>`.
 * A new write method is therefore in scope the moment it is declared, with no
 * chance to forget to register it here.
 *
 * Known limit, stated plainly: this matches `guardedWrite(` in the handler's
 * own source text, so a handler delegating to a helper that guards internally
 * would need an exemption below. That is fine -- the failure mode being
 * defended against is a *forgotten* guard, not a disguised one.
 */

const api = interfaceMembers(parse('src/shared/ipc.ts'), 'Api');
const handlers = objectProps(parse('src/main/ipc.ts'), 'handlers');
const byName = new Map(handlers.map((h) => [h.name, h.text]));

const MUTATING = api
  .filter((m) => /^Promise<WriteResult(\[\])?>$/.test(m.returnType))
  .map((m) => m.name);

/**
 * Methods that mutate but legitimately do not call `guardedWrite`. Each entry
 * needs a reason, and each is re-validated below so a stale exemption for a
 * deleted method fails instead of rotting.
 */
const EXEMPT: Record<string, string> = {
  // Puts the receiver into pairing mode. Changes no stored configuration, so
  // there is nothing a backup would protect. src/main/ipc.ts.
  startPairing: 'pairing mode only; mutates no device configuration',

  // IS the recovery path. Taking a fresh backup of the state being replaced
  // would overwrite the known-good backup with the bad state.
  restoreBackup: 'the restore path itself; a pre-write backup would clobber the good one',

  // Delegates to switcher.applyProfile(), which calls
  // deviceManager.ensureBackup() itself -- the invariant is upheld by a second
  // implementation rather than by guardedWrite. Asserted separately below.
  applyProfile: 'delegates to switcher.applyProfile, which calls ensureBackup directly',
};

describe('every mutating IPC handler takes a backup first', () => {
  it('parsed plausible Api and handler tables', () => {
    // Non-vacuity guards: an empty parse here would make every assertion
    // below trivially true.
    expect(api.length, 'parsed no Api members').toBeGreaterThan(80);
    expect(handlers.length, 'parsed no handlers -- was the object renamed?').toBeGreaterThan(80);
    expect(
      MUTATING.length,
      'found no Promise<WriteResult> methods -- did the write result type change?',
    ).toBeGreaterThan(25);
  });

  it('wraps every mutating handler in guardedWrite()', () => {
    const unguarded = MUTATING.filter((name) => {
      if (name in EXEMPT) return false;
      const text = byName.get(name);
      return !text || !text.includes('guardedWrite(');
    });

    expect(
      unguarded,
      `mutating Api methods whose handler does not call guardedWrite(): ${unguarded.join(', ')}. ` +
        'Wrap it, or add a documented entry to EXEMPT in this file.',
    ).toEqual([]);
  });

  it('has no stale exemptions', () => {
    const names = new Set(api.map((m) => m.name));
    const stale = Object.keys(EXEMPT).filter((n) => !names.has(n));
    expect(stale, `EXEMPT names no longer on Api: ${stale.join(', ')}`).toEqual([]);

    // An exemption for something that is no longer mutating is also stale.
    const notMutating = Object.keys(EXEMPT).filter((n) => !MUTATING.includes(n));
    expect(notMutating, `EXEMPT entries that are not mutating: ${notMutating.join(', ')}`).toEqual(
      [],
    );
  });

  /**
   * applyProfile's exemption is only valid while the switcher really does take
   * the backup. If that call is ever removed, the exemption silently becomes a
   * hole -- so pin it here.
   */
  it('keeps the switcher’s own ensureBackup call that applyProfile relies on', () => {
    const src = readFileSync(resolve(APP_ROOT, 'src/main/profiles/switcher.ts'), 'utf8');
    const calls = src.match(/deviceManager\.ensureBackup\(/g) ?? [];
    expect(
      calls.length,
      'switcher.ts no longer calls deviceManager.ensureBackup(); applyProfile’s ' +
        'exemption in this file is now a gap in CLAUDE.md invariant #1',
    ).toBeGreaterThan(0);
  });

  it('has a handler for every Api method, and no orphan handlers', () => {
    // `handlers` is typed `{ [K in keyof Api]?: … }` -- every key optional --
    // so tsc does NOT catch a missing handler. An Api method with no handler
    // is a runtime "unknown IPC method" the first time the UI calls it.
    const declared = api.map((m) => m.name).filter((n) => n !== 'on'); // `on` is preload-only
    const missing = declared.filter((n) => !byName.has(n));
    const orphan = handlers.map((h) => h.name).filter((n) => !api.some((m) => m.name === n));

    expect(missing, `Api methods with no handler in main/ipc.ts: ${missing.join(', ')}`).toEqual(
      [],
    );
    expect(orphan, `handlers that match no Api method (typo?): ${orphan.join(', ')}`).toEqual([]);
  });
});
