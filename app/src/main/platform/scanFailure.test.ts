import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A failed process scan rejects, on every OS — it never comes back as "nothing
 * is running". Read as an empty list, it told auto-switch that every game had
 * just quit: a switch to the desktop and straight back, popups and all, for one
 * bad read. The switcher skips a poll that throws. The best-effort callers —
 * the trigger-icon lookup and the process picker — still resolve, with nothing.
 *
 * Windows was fixed first; macOS's `ps` and Linux's `/proc` listing kept the
 * old "empty on error" until all three were held to it here.
 */

const h = vi.hoisted(() => ({
  /** What the next `exec` answers: an error, or stdout. */
  exec: { err: null as Error | null, stdout: '' },
  /** What listing /proc does. */
  readdir: null as null | (() => Promise<string[]>),
}));

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {} }));
vi.mock('../profiles/processIcons', () => ({ iconFor: async () => null }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  exec: (_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) =>
    cb(h.exec.err, h.exec.stdout),
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const promises = {
    ...real.promises,
    readdir: (...args: Parameters<typeof real.promises.readdir>) =>
      h.readdir ? h.readdir() : real.promises.readdir(...args),
  };
  return { ...real, default: { ...real, promises }, promises };
});

const { win } = await import('./win');
const { mac } = await import('./mac');
const { linux } = await import('./linux');

beforeEach(() => {
  h.exec = { err: null, stdout: '' };
  h.readdir = null;
});

describe('a failed process scan', () => {
  it('rejects on Windows when tasklist fails or prints nothing', async () => {
    h.exec = { err: new Error('tasklist failed'), stdout: '' };
    await expect(win.runningProcessNames()).rejects.toThrow('tasklist failed');
    h.exec = { err: null, stdout: '' };
    await expect(win.runningProcessNames()).rejects.toThrow();
  });

  it('rejects on macOS when ps fails or prints nothing', async () => {
    h.exec = { err: new Error('ps failed'), stdout: '' };
    await expect(mac.runningProcessNames()).rejects.toThrow('ps failed');
    h.exec = { err: null, stdout: '' };
    await expect(mac.runningProcessNames()).rejects.toThrow();
  });

  it('is still "not found" and an empty picker on macOS', async () => {
    h.exec = { err: new Error('ps failed'), stdout: '' };
    await expect(mac.pathForRunningProcess('cs2')).resolves.toBeNull();
    await expect(mac.listRunningProcesses(true)).resolves.toEqual([]);
  });

  it('rejects on Linux when /proc cannot be listed, or lists no process', async () => {
    h.readdir = () => Promise.reject(new Error('EACCES'));
    await expect(linux.runningProcessNames()).rejects.toThrow('EACCES');
    // /proc that lists only its non-process entries is a failed scan too: this
    // process, at least, is always running.
    h.readdir = async () => ['cpuinfo', 'self', 'sys'];
    await expect(linux.runningProcessNames()).rejects.toThrow();
  });

  it('is still "not found" and an empty picker on Linux', async () => {
    h.readdir = () => Promise.reject(new Error('EACCES'));
    await expect(linux.pathForRunningProcess('cs2')).resolves.toBeNull();
    await expect(linux.listRunningProcesses(true)).resolves.toEqual([]);
  });
});

describe('a scan that works', () => {
  it('reads the names on Windows and macOS', async () => {
    h.exec = { err: null, stdout: '"System","4"\r\n"cs2.exe","1234"\r\n' };
    expect(await win.runningProcessNames()).toEqual(new Set(['system', 'cs2.exe']));
    h.exec = {
      err: null,
      stdout: '  1 /sbin/launchd\n 812 /Applications/Steam.app/Contents/MacOS/steam_osx\n',
    };
    expect(await mac.runningProcessNames()).toEqual(new Set(['launchd', 'steam_osx']));
  });
});
