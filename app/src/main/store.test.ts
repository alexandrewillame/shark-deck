import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir: string;

const {
  installStorage,
  readJson,
  writeJson,
  withFileLock,
  paths,
  writeBackup,
  listBackupFiles,
  readBackup,
  deleteBackupFile,
  readBackupText,
  parseBackupFile,
  MAX_BACKUP_IMPORT_CHARS,
} = await import('./store');
const { createFsStorage } = await import('./store-fs');
// The desktop backend, rooted at the fresh temp dir each test makes below.
installStorage(createFsStorage(() => dir));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharkdeck-store-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readJson / writeJson', () => {
  it('round-trips a value', async () => {
    const f = paths.profiles();
    await writeJson(f, [{ id: 'a' }]);
    expect(await readJson(f, [])).toEqual([{ id: 'a' }]);
  });

  it('returns the fallback when the file is absent', async () => {
    expect(await readJson(paths.profiles(), ['fallback'])).toEqual(['fallback']);
  });

  it('writes atomically — no leftover .tmp, and a reader never sees a partial file', async () => {
    const f = paths.settings();
    await writeJson(f, { a: 1 });
    const siblings = await fs.readdir(path.dirname(f));
    expect(siblings.some((s) => s.endsWith('.tmp'))).toBe(false);
  });

  it('keeps a .bak of the previous good version', async () => {
    const f = paths.settings();
    await writeJson(f, { v: 1 });
    await writeJson(f, { v: 2 });
    expect(JSON.parse(await fs.readFile(`${f}.bak`, 'utf8'))).toEqual({ v: 1 });
  });

  it('recovers from .bak when the primary is corrupt, without returning the fallback', async () => {
    const f = paths.settings();
    await writeJson(f, { good: 1 });
    await writeJson(f, { good: 2 }); // now .bak holds {good:1}
    await fs.writeFile(f, '{ this is not json', 'utf8');
    expect(await readJson(f, { fallback: true })).toEqual({ good: 1 });
  });

  it('moves an unparseable file aside (no usable .bak) and preserves it', async () => {
    const f = paths.macroLibrary();
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, 'garbage', 'utf8');
    expect(await readJson(f, [])).toEqual([]);
    const siblings = await fs.readdir(path.dirname(f));
    expect(siblings.some((s) => s.startsWith(path.basename(f) + '.corrupt-'))).toBe(true);
  });
});

describe('withFileLock', () => {
  it('serialises read-modify-write so neither concurrent update is lost', async () => {
    const f = paths.profiles();
    await writeJson(f, [] as string[]);

    const append = (id: string) =>
      withFileLock(f, async () => {
        const cur = await readJson<string[]>(f, []);
        // force interleave if the lock is not held
        await new Promise((r) => setTimeout(r, 5));
        await writeJson(f, [...cur, id]);
      });

    await Promise.all([append('a'), append('b'), append('c')]);
    expect((await readJson<string[]>(f, [])).sort()).toEqual(['a', 'b', 'c']);
  });

  it('a rejection does not poison later holders of the same lock', async () => {
    const f = paths.settings();
    await expect(
      withFileLock(f, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(withFileLock(f, async () => 'ok')).resolves.toBe('ok');
  });
});

describe('ensureDirs implicit via writeJson', () => {
  it('creates the config dir if missing', async () => {
    expect(existsSync(paths.config())).toBe(false);
    await writeJson(paths.settings(), {});
    expect(existsSync(paths.config())).toBe(true);
  });
});

describe('backups', () => {
  const blocks = { profile1: 'aa bb', receiverLed: 'cc' };

  it('round-trips a backup through write / list / read', async () => {
    const file = await writeBackup('v8', 'SERIAL-1', blocks);
    expect(await listBackupFiles('v8')).toEqual([file]);
    const b = await readBackup(file);
    expect(b?.model).toBe('v8');
    expect(b?.blocks).toEqual(blocks);
  });

  it('lists only the requested model, newest first', async () => {
    const a = await writeBackup('v8', 's', blocks);
    // The filename stamp has millisecond resolution, but two writes in the
    // same millisecond would tie — force distinct stamps.
    await new Promise((r) => setTimeout(r, 5));
    const b = await writeBackup('v8', 's', blocks);
    await writeBackup('r85he', 's', blocks);
    expect(await listBackupFiles('v8')).toEqual([b, a]);
  });

  it('deleteBackupFile removes it, and listBackupFiles stops reporting it', async () => {
    const file = await writeBackup('v8', 's', blocks);
    expect(await deleteBackupFile(file)).toBe(true);
    expect(await listBackupFiles('v8')).toEqual([]);
    expect(await readBackup(file)).toBeNull();
  });

  it('deleting an already-gone backup reports false rather than throwing', async () => {
    expect(await deleteBackupFile('v8-s-2020-01-01T00-00-00-000Z.json')).toBe(false);
  });

  it('refuses to read or delete anything outside the backups directory', async () => {
    const file = await writeBackup('v8', 's', blocks);
    const outside = path.join(dir, 'secret.json');
    await fs.writeFile(outside, '{"model":"v8","blocks":{},"createdAt":0}', 'utf8');
    for (const bad of [
      '../secret.json',
      `../../${path.basename(outside)}`,
      outside,
      'sub/dir.json',
      'no-extension',
    ]) {
      expect(await readBackup(bad), bad).toBeNull();
      expect(await deleteBackupFile(bad), bad).toBe(false);
    }
    // …and none of that touched the real file or the one it tried to escape to.
    expect(existsSync(outside)).toBe(true);
    expect(await listBackupFiles('v8')).toEqual([file]);
  });
});

describe('backup files carried between editions (export / import)', () => {
  it('round-trips an exported backup through the import parser', async () => {
    const blocks = { '0x84': '00 84 00 00', keymatrix_base: '[{"slot":1}]' };
    const file = await writeBackup('R85HE', 'abc', blocks, 1_700_000_000_000);
    const text = await readBackupText(file);
    expect(text).not.toBeNull();
    expect(parseBackupFile(text!)).toEqual({
      model: 'R85HE',
      serial: 'abc',
      createdAt: 1_700_000_000_000,
      blocks,
    });
  });

  it('accepts only what writeBackup produces', () => {
    const bad = [
      'not json',
      '[]',
      'null',
      '{}',
      '{"blocks":{"a":"b"}}',
      '{"model":"../../settings","blocks":{"a":"b"}}', // the model lands in a file name
      '{"model":"V8","blocks":{}}',
      '{"model":"V8","blocks":["a"]}',
      '{"model":"V8","blocks":{"a":1}}',
    ];
    for (const json of bad) expect('error' in parseBackupFile(json), json).toBe(true);
  });

  it('fills in a missing serial and timestamp', () => {
    const parsed = parseBackupFile('{"model":"V8","blocks":{"profile1":"08 0f"}}');
    expect(parsed).toMatchObject({ model: 'V8', serial: 'imported' });
    expect('createdAt' in parsed && Number.isFinite(parsed.createdAt)).toBe(true);
  });

  it('refuses a file far larger than any backup', () => {
    const huge = `{"model":"V8","blocks":{"a":"${'0'.repeat(MAX_BACKUP_IMPORT_CHARS)}"}}`;
    expect(parseBackupFile(huge)).toEqual({ error: 'file too large to be a backup' });
  });

  it('exports nothing for a name that is not a plain backup file name', async () => {
    expect(await readBackupText('../config/settings.json')).toBeNull();
  });
});
