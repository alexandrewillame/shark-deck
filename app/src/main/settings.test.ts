import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dir: string;

const { getSettings, setSettings, getSettingsSync } = await import('./settings');
const { installStorage, paths } = await import('./store');
const { createFsStorage } = await import('./store-fs');
installStorage(createFsStorage(() => dir));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sharkdeck-settings-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeRaw(obj: unknown) {
  await fs.mkdir(paths.config(), { recursive: true });
  await fs.writeFile(paths.settings(), JSON.stringify(obj), 'utf8');
}

describe('settings coercion', () => {
  it('clamps a NaN pollSeconds to the default', async () => {
    await writeRaw({ pollSeconds: Number.NaN });
    expect((await getSettings()).pollSeconds).toBe(2);
  });

  it('coerces a numeric string pollSeconds', async () => {
    await writeRaw({ pollSeconds: '5' });
    expect((await getSettings()).pollSeconds).toBe(5);
  });

  it('clamps an out-of-range pollSeconds into [1,60]', async () => {
    await writeRaw({ pollSeconds: 9999 });
    expect((await getSettings()).pollSeconds).toBe(60);
    await writeRaw({ pollSeconds: 0 });
    expect((await getSettings()).pollSeconds).toBe(1);
  });

  it('drops a non-boolean minimizeToTray and unknown keys', async () => {
    await writeRaw({ minimizeToTray: 'yes', bogusKey: 123 });
    const s = await getSettings();
    expect(s.minimizeToTray).toBe(true); // default
    expect('bogusKey' in s).toBe(false);
  });

  it('rejects a bad themeMode', async () => {
    await writeRaw({ themeMode: 'rainbow' });
    expect((await getSettings()).themeMode).toBe('dark');
  });

  it('accepts only a background the renderer can draw', async () => {
    await writeRaw({ background: 'smoke' });
    expect((await getSettings()).background).toBe('smoke');
    await writeRaw({ background: 'plasma-storm' });
    expect((await getSettings()).background).toBe('none');
  });

  it('moves a retired background on to its successor, or off', async () => {
    // Artistic became Paint, Paint became Military, then Military and Petrol
    // gave way to Rain; Primal left the set.
    for (const old of ['artistic', 'paint', 'military', 'petrol']) {
      await writeRaw({ background: old });
      expect((await getSettings()).background, old).toBe('rain');
    }
    await writeRaw({ background: 'primal' });
    expect((await getSettings()).background).toBe('none');
  });

  it('keeps a background turned off, and turns off one it cannot draw', async () => {
    // The default only fills a file that names no background: someone who
    // chose None before a background became the default keeps None.
    await writeRaw({ background: 'none' });
    expect((await getSettings()).background).toBe('none');
    await writeRaw({ background: 'plasma' });
    expect((await getSettings()).background).toBe('none');
  });

  it('defaults the background to Smoke in Shark Cyan, leaving Animate to the system', async () => {
    await writeRaw({});
    const s = await getSettings();
    expect(s).toMatchObject({
      background: 'smoke',
      palette: 'shark-cyan',
      backgroundPalette: true,
      backgroundIntensity: 60,
    });
    // Unset: the renderer follows the system's reduced-motion setting until
    // the switch is flipped (renderer/background/motion.ts).
    expect(s.backgroundAnimate).toBeUndefined();
    await writeRaw({ backgroundAnimate: 'yes' });
    expect((await getSettings()).backgroundAnimate).toBeUndefined();
  });

  it('keeps an Animate choice once made, either way', async () => {
    for (const on of [true, false]) {
      await setSettings({ backgroundAnimate: on });
      expect((await setSettings({ pollSeconds: 3 })).backgroundAnimate).toBe(on);
      expect(JSON.parse(await fs.readFile(paths.settings(), 'utf8')).backgroundAnimate).toBe(on);
    }
  });

  it('clamps the background intensity into [0,100] and coerces a numeric string', async () => {
    await writeRaw({ backgroundIntensity: 400 });
    expect((await getSettings()).backgroundIntensity).toBe(100);
    await writeRaw({ backgroundIntensity: '35' });
    expect((await getSettings()).backgroundIntensity).toBe(35);
    await writeRaw({ backgroundIntensity: Number.NaN });
    expect((await getSettings()).backgroundIntensity).toBe(60);
  });

  it('keeps the background through an unrelated change', async () => {
    // `coerce` is an allowlist: a field it does not name is dropped on every
    // write, which would switch the background off the next time anything
    // else in settings changed.
    await setSettings({ background: 'nebula', backgroundIntensity: 80, backgroundAnimate: false });
    const next = await setSettings({ pollSeconds: 5 });
    expect(next).toMatchObject({
      background: 'nebula',
      backgroundIntensity: 80,
      backgroundAnimate: false,
    });
  });

  it('filters non-string entries out of deviceOrder', async () => {
    await writeRaw({ deviceOrder: ['a', 2, null, 'b'] });
    expect((await getSettings()).deviceOrder).toEqual(['a', 'b']);
  });

  it('setSettings persists a coerced value and getSettingsSync agrees', async () => {
    await setSettings({ pollSeconds: '7' as unknown as number });
    expect(getSettingsSync().pollSeconds).toBe(7);
    const onDisk = JSON.parse(await fs.readFile(paths.settings(), 'utf8'));
    expect(onDisk.pollSeconds).toBe(7);
  });
});
