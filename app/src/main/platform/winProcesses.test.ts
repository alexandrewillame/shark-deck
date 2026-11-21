import { basename } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Auto-switch's question on Windows — what is running? — asked of Windows
 * itself (winProcesses.ts) rather than of `tasklist`, which cost about half a
 * second of CPU on every poll. The native call runs where it can: on Windows,
 * against this very test's process. The fallback to `tasklist` runs anywhere.
 */
describe.skipIf(process.platform !== 'win32')('the native process list', () => {
  it('names what runs as tasklist did: image names, lower-cased', async () => {
    const { processNames } = await import('./winProcesses');
    const names = processNames();
    expect(names.has(basename(process.execPath).toLowerCase())).toBe(true);
    expect(names.has('system')).toBe(true);
    for (const n of names) expect(n).toBe(n.toLowerCase());
  });

  it('costs milliseconds, not the half second tasklist did', async () => {
    const { processNames } = await import('./winProcesses');
    processNames();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) processNames();
    expect((performance.now() - t0) / 20).toBeLessThan(100);
  });
});

describe('the tasklist fallback', () => {
  const TASKLIST =
    '"System","4","Services","0","152 K"\r\n' + '"cs2.exe","1234","Console","1","2,000,000 K"\r\n';

  async function platformWith(nativeModule: () => unknown) {
    vi.resetModules();
    vi.doMock('electron', () => ({ app: { getPath: () => '' }, shell: {} }));
    vi.doMock('node:child_process', () => ({
      exec: vi.fn((_cmd: string, _opts: unknown, cb: (e: null, out: string) => void) =>
        cb(null, TASKLIST),
      ),
      execFile: vi.fn(),
    }));
    vi.doMock('./winProcesses', nativeModule as never);
    const { win } = await import('./win');
    const { exec } = await import('node:child_process');
    return { win, exec: exec as unknown as ReturnType<typeof vi.fn> };
  }
  afterEach(() => {
    vi.doUnmock('./winProcesses');
    vi.doUnmock('node:child_process');
    vi.doUnmock('electron');
  });

  it('answers when the native list cannot load, and stays on tasklist', async () => {
    const { win, exec } = await platformWith(() => {
      throw new Error('no koffi binary here');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await win.runningProcessNames()).toEqual(new Set(['system', 'cs2.exe']));
    expect(await win.runningProcessNames()).toEqual(new Set(['system', 'cs2.exe']));
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('answers when the native list fails, and asks Windows again next time', async () => {
    let calls = 0;
    const { win, exec } = await platformWith(() => ({
      processNames: () => {
        calls++;
        if (calls === 1) throw new Error('no snapshot');
        return new Set(['explorer.exe']);
      },
    }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await win.runningProcessNames()).toEqual(new Set(['system', 'cs2.exe']));
    expect(await win.runningProcessNames()).toEqual(new Set(['explorer.exe']));
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
