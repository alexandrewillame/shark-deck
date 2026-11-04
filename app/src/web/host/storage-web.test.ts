import { describe, expect, it } from 'vitest';
import { createMemoryKv, type Kv } from './kv';
import { createWebStorage } from './storage-web';

describe('the browser edition storage backend', () => {
  it('answers synchronous reads from what was stored before boot', async () => {
    const kv = createMemoryKv();
    await kv.put('docs', 'config/settings.json', JSON.stringify({ language: 'fr' }));
    const storage = await createWebStorage(kv);
    expect(storage.readJsonSync('config/settings.json', null)).toEqual({ language: 'fr' });
    expect(storage.readJsonSync('config/missing.json', 'fallback')).toBe('fallback');
  });

  it('writes through to the Kv, and copies — a caller cannot mutate what is stored', async () => {
    const kv = createMemoryKv();
    const storage = await createWebStorage(kv);
    const doc = { items: [1] };
    await storage.writeJson('config/a.json', doc);
    doc.items.push(2);
    expect(await kv.get('docs', 'config/a.json')).toBe('{"items":[1]}');
    const read = await storage.readJson<{ items: number[] }>('config/a.json', { items: [] });
    read.items.push(3);
    expect(storage.readJsonSync('config/a.json', null)).toEqual({ items: [1] });
  });

  it('keeps memory as it was when a write fails', async () => {
    const kv = createMemoryKv();
    const storage = await createWebStorage(kv);
    await storage.writeJson('config/a.json', { v: 1 });
    const failing: Kv = { ...kv, put: async () => Promise.reject(new Error('quota')) };
    const broken = await createWebStorage(failing);
    await expect(broken.writeJson('config/a.json', { v: 2 })).rejects.toThrow('quota');
    expect(broken.readJsonSync('config/a.json', null)).toEqual({ v: 1 });
  });

  it('reads an unparseable record as absent', async () => {
    const kv = createMemoryKv();
    await kv.put('docs', 'config/bad.json', '{ nope');
    const storage = await createWebStorage(kv);
    expect(await storage.readJson('config/bad.json', 'fallback')).toBe('fallback');
  });

  it('lists, reads, writes and deletes backups', async () => {
    const storage = await createWebStorage(createMemoryKv());
    await storage.writeBackupText('V8-x-1.json', '{"model":"V8"}');
    expect(await storage.listBackups()).toEqual(['V8-x-1.json']);
    expect(await storage.readBackupText('V8-x-1.json')).toBe('{"model":"V8"}');
    expect(await storage.deleteBackup('V8-x-1.json')).toBe(true);
    expect(await storage.deleteBackup('V8-x-1.json')).toBe(false);
    expect(await storage.readBackupText('V8-x-1.json')).toBeNull();
  });

  it('serves store.ts end to end — settings and backups', async () => {
    const store = await import('../../main/store');
    const { getSettingsSync, setSettings } = await import('../../main/settings');
    store.installStorage(await createWebStorage(createMemoryKv()));

    await setSettings({ language: 'de' });
    expect(getSettingsSync().language).toBe('de');

    const file = await store.writeBackup('R85HE', 'webhid:3151:5029:0:0', { '0x84': '00 84' });
    expect(file).toMatch(/^R85HE-webhid_3151_5029_0_0-.+\.json$/);
    expect(await store.listBackupFiles('R85HE')).toEqual([file]);
    expect((await store.readBackup(file))?.blocks).toEqual({ '0x84': '00 84' });
  });
});
