import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { APP_ROOT, interfaceMembers, objectProps, parse, type Prop } from '../lib/ast';

/**
 * CLAUDE.md invariant #1: a full backup exists before the first write to any
 * device. Every mutating handler goes through `guardedWrite()`, which calls
 * `deviceManager.ensureBackup()` and refuses the write if no backup could be
 * taken.
 *
 * The handlers live in two kinds of table. `deviceHandlers` in
 * src/main/handlers.ts is shared by both hosts — the Electron main process and
 * the browser edition — and holds every device read and write, so
 * `guardedWrite` exists once. Each host then adds its own table for what only
 * it can do (`desktopHandlers` in src/main/ipc.ts). So the invariant is
 * checked in two parts: every write lives in the SHARED table and is guarded
 * there, and no host table can shadow a shared method.
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
const shared = objectProps(parse('src/main/handlers.ts'), 'deviceHandlers');
const sharedByName = new Map(shared.map((h) => [h.name, h.text]));

/** Each host's own table. A new host adds a line here. */
const HOSTS: { name: string; file: string; table: Prop[] }[] = [
  {
    name: 'desktop',
    file: 'src/main/ipc.ts',
    table: objectProps(parse('src/main/ipc.ts'), 'desktopHandlers'),
  },
  {
    name: 'browser',
    file: 'src/web/host/handlers.ts',
    table: objectProps(parse('src/web/host/handlers.ts'), 'browserHandlers'),
  },
];

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
  // there is nothing a backup would protect. src/main/handlers.ts.
  startPairing: 'pairing mode only; mutates no device configuration',

  // IS the recovery path. Taking a fresh backup of the state being replaced
  // would overwrite the known-good backup with the bad state.
  restoreBackup: 'the restore path itself; a pre-write backup would clobber the good one',

  // Desktop only (an auto-switch app profile). Delegates to
  // switcher.applyProfile(), which calls deviceManager.ensureBackup() itself
  // -- the invariant is upheld by a second implementation rather than by
  // guardedWrite. Asserted separately below.
  applyProfile: 'delegates to switcher.applyProfile, which calls ensureBackup directly',
};

describe('every mutating handler takes a backup first', () => {
  it('parsed plausible Api and handler tables', () => {
    // Non-vacuity guards: an empty parse here would make every assertion
    // below trivially true.
    expect(api.length, 'parsed no Api members').toBeGreaterThan(80);
    expect(
      shared.length,
      'parsed no shared handlers -- was deviceHandlers renamed?',
    ).toBeGreaterThan(60);
    for (const host of HOSTS) {
      expect(host.table.length, `parsed no ${host.name} handlers in ${host.file}`).toBeGreaterThan(
        10,
      );
    }
    expect(
      MUTATING.length,
      'found no Promise<WriteResult> methods -- did the write result type change?',
    ).toBeGreaterThan(25);
  });

  it('wraps every mutating handler in guardedWrite(), in the shared table', () => {
    const unguarded = MUTATING.filter((name) => {
      if (name in EXEMPT) return false;
      const text = sharedByName.get(name);
      return !text || !text.includes('guardedWrite(');
    });

    expect(
      unguarded,
      `mutating Api methods with no guardedWrite() handler in src/main/handlers.ts: ` +
        `${unguarded.join(', ')}. Device writes belong in the shared table, wrapped -- or ` +
        'add a documented entry to EXEMPT in this file.',
    ).toEqual([]);
  });

  it('lets no host table shadow or bypass a shared method', () => {
    for (const host of HOSTS) {
      const shadowed = host.table.map((h) => h.name).filter((n) => sharedByName.has(n));
      expect(
        shadowed,
        `${host.file} redefines shared handler(s) ${shadowed.join(', ')}; the spread order ` +
          'would silently pick one of the two.',
      ).toEqual([]);

      const hostWrites = host.table
        .map((h) => h.name)
        .filter((n) => MUTATING.includes(n) && !(n in EXEMPT));
      expect(
        hostWrites,
        `${host.file} implements mutating method(s) ${hostWrites.join(', ')} outside the ` +
          'shared, guarded table.',
      ).toEqual([]);
    }
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

  it('gives every host a handler for every Api method, and no orphan handlers', () => {
    // tsc proves this too (`satisfies` in each host file), but only for the
    // files it is pointed at; this keeps the guarantee readable in one place.
    const declared = api.map((m) => m.name).filter((n) => n !== 'on'); // `on` is the event channel
    for (const host of HOSTS) {
      const names = new Set([...shared.map((h) => h.name), ...host.table.map((h) => h.name)]);
      const missing = declared.filter((n) => !names.has(n));
      const orphan = [...names].filter((n) => !declared.includes(n));
      expect(
        missing,
        `Api methods the ${host.name} host does not handle: ${missing.join(', ')}`,
      ).toEqual([]);
      expect(
        orphan,
        `${host.name} handlers that match no Api method (typo?): ${orphan.join(', ')}`,
      ).toEqual([]);
    }
  });
});
