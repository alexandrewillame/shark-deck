import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Linux process identity — what auto-switch matches triggers against.
 *
 * A Windows game under Wine or Proton shows up in `/proc/<pid>/exe` as Wine's
 * loader (`wine64-preloader`), never as `cs2.exe`; named that way, no `.exe`
 * trigger could ever fire on Linux. These run against a fake `/proc`.
 */

interface FakeProc {
  exe?: string;
  comm?: string;
  cmdline?: string;
}
const h = vi.hoisted(() => ({ procs: {} as Record<string, FakeProc> }));

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {} }));
vi.mock('../profiles/processIcons', () => ({ iconFor: async () => null }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const fail = () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
  const field = (p: string): [FakeProc | undefined, string] => {
    const m = /^\/proc\/(\d+)\/(\w+)$/.exec(String(p));
    return m ? [h.procs[m[1]!], m[2]!] : [undefined, ''];
  };
  const promises = {
    ...real.promises,
    readdir: async (p: string) =>
      p === '/proc' ? [...Object.keys(h.procs), 'self', 'sys'] : real.promises.readdir(p),
    readlink: async (p: string) => {
      const [proc, f] = field(p);
      return f === 'exe' && proc?.exe ? proc.exe : fail();
    },
    readFile: async (p: string, ...rest: unknown[]) => {
      const [proc, f] = field(p);
      if (!proc) return (real.promises.readFile as (...a: unknown[]) => unknown)(p, ...rest);
      const v = f === 'comm' ? proc.comm : f === 'cmdline' ? proc.cmdline : undefined;
      return v === undefined ? fail() : v;
    },
  };
  return { ...real, default: { ...real, promises }, promises };
});

const { linux, desktopExecArg } = await import('./linux');

const PROTON_BIN =
  '/home/u/.steam/steam/steamapps/common/Proton 9.0 (Beta)/files/bin/wine64-preloader';
const CS2_WIN =
  'Z:\\home\\u\\.steam\\steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe';

beforeEach(() => {
  h.procs = {};
});

describe('Linux running processes', () => {
  it('names a native program by its executable', async () => {
    h.procs = { '10': { exe: '/usr/bin/firefox', comm: 'firefox' } };
    expect(await linux.runningProcessNames()).toEqual(new Set(['firefox']));
  });

  it('names a Proton game by the Windows program it runs, not by Wine', async () => {
    h.procs = { '20': { exe: PROTON_BIN, comm: 'cs2.exe', cmdline: `${CS2_WIN}\0-steam\0` } };
    const names = await linux.runningProcessNames();
    expect(names.has('cs2.exe')).toBe(true);
    expect(names.has('wine64-preloader')).toBe(false);
    // Z: is Wine's view of /, so the game's own file is found for its icon.
    expect(await linux.pathForRunningProcess('cs2.exe')).toBe(
      '/home/u/.steam/steam/steamapps/common/Counter-Strike Global Offensive/game/bin/win64/cs2.exe',
    );
  });

  it('falls back to comm when the command line cannot be read', async () => {
    h.procs = { '21': { exe: '/usr/lib/wine/wine64-preloader', comm: 'game.exe' } };
    expect(await linux.runningProcessNames()).toEqual(new Set(['game.exe']));
  });

  it('never guesses from a comm cut short of its .exe', async () => {
    // comm holds 15 characters: "Cyberpunk2077.exe" arrives as "Cyberpunk2077.e".
    h.procs = { '22': { exe: '/usr/lib/wine/wine64-preloader', comm: 'Cyberpunk2077.e' } };
    expect(await linux.runningProcessNames()).toEqual(new Set(['wine64-preloader']));
  });

  it('reads a program replaced by an update as itself', async () => {
    h.procs = { '30': { exe: '/opt/game/game.x86_64 (deleted)', comm: 'game.x86_64' } };
    expect(await linux.runningProcessNames()).toEqual(new Set(['game.x86_64']));
  });

  it("keeps Wine's own service processes out of the picker", async () => {
    h.procs = {
      '20': { exe: PROTON_BIN, comm: 'cs2.exe', cmdline: `${CS2_WIN}\0` },
      '23': {
        exe: PROTON_BIN,
        comm: 'services.exe',
        cmdline: 'C:\\windows\\system32\\services.exe\0',
      },
    };
    const names = (await linux.listRunningProcesses(false)).map((p) => p.name);
    expect(names).toContain('cs2.exe');
    expect(names).not.toContain('services.exe');
  });
});

describe('the autostart entry', () => {
  it('quotes a plain path as it is', () => {
    expect(desktopExecArg('/home/u/Apps/SharkDeck.AppImage')).toBe(
      '"/home/u/Apps/SharkDeck.AppImage"',
    );
  });

  it('escapes what the Desktop Entry spec reserves', () => {
    // % is a field code; ", `, $ and \ take a backslash inside quotes, and the
    // string level doubles every backslash again.
    expect(desktopExecArg('/home/u/Shark%20Deck.AppImage')).toBe(
      '"/home/u/Shark%%20Deck.AppImage"',
    );
    expect(desktopExecArg('/home/u/a"b`c$d')).toBe('"/home/u/a\\\\"b\\\\`c\\\\$d"');
    expect(desktopExecArg('/home/u/a\\b')).toBe('"/home/u/a\\\\\\\\b"');
  });
});
