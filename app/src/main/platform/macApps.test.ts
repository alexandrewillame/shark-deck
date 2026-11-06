import { describe, expect, it, vi } from 'vitest';

/**
 * The macOS app picker (auto-switch's "running now" list). On a fresh macOS 26
 * install it listed 26 entries and not one app a person had opened: the agents
 * macOS runs as `.app` bundles of its own, and the helper apps nested inside
 * Shark Deck's bundle (and every other Electron or Chromium app's).
 */

const h = vi.hoisted(() => ({ stdout: '' }));

vi.mock('electron', () => ({ app: { getPath: () => '', isPackaged: false }, shell: {} }));
vi.mock('../profiles/processIcons', () => ({ iconFor: async () => null }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  exec: (_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) =>
    cb(null, h.stdout),
}));

const { mac, isUserApp } = await import('./mac');

const STEAM_GAME =
  '/Users/alex/Library/Application Support/Steam/steamapps/common/Neon Drift/NeonDrift.app/Contents/MacOS/NeonDrift';

describe('isUserApp', () => {
  it.each([
    '/Applications/Safari.app/Contents/MacOS/Safari',
    '/System/Applications/Chess.app/Contents/MacOS/Chess',
    STEAM_GAME,
  ])('keeps %s', (comm) => expect(isUserApp(comm)).toBe(true));

  it.each([
    // agents macOS runs as bundles of its own
    '/System/Library/CoreServices/AirPlayUIAgent.app/Contents/MacOS/AirPlayUIAgent',
    '/System/Library/PrivateFrameworks/IDS.framework/identityservicesd.app/Contents/MacOS/identityservicesd',
    '/Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtect',
    // a helper nested inside another app's bundle
    '/Applications/SharkDeck.app/Contents/Frameworks/SharkDeck Helper (Renderer).app/Contents/MacOS/SharkDeck Helper (Renderer)',
    // a daemon or command-line tool
    '/usr/libexec/trustd',
  ])('drops %s', (comm) => expect(isUserApp(comm)).toBe(false));
});

describe('mac.listRunningProcesses', () => {
  h.stdout = [
    '    1 /sbin/launchd',
    '  412 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '  498 /System/Library/CoreServices/WindowManager.app/Contents/MacOS/WindowManager',
    '  610 /Library/Apple/System/Library/CoreServices/XProtect.app/Contents/MacOS/XProtect',
    '  901 /Applications/SharkDeck.app/Contents/MacOS/SharkDeck',
    '  905 /Applications/SharkDeck.app/Contents/Frameworks/SharkDeck Helper (GPU).app/Contents/MacOS/SharkDeck Helper (GPU)',
    '  907 /Applications/SharkDeck.app/Contents/Frameworks/SharkDeck Helper (Renderer).app/Contents/MacOS/SharkDeck Helper (Renderer)',
    ' 1201 /Applications/Safari.app/Contents/MacOS/Safari',
    ' 1302 /System/Applications/Chess.app/Contents/MacOS/Chess',
    ` 1404 ${STEAM_GAME}`,
    '',
  ].join('\n');

  it('offers only the apps a person opened, by bundle', async () => {
    const list = await mac.listRunningProcesses(true);
    expect(list.map((p) => [p.name, p.path])).toEqual([
      ['chess', '/System/Applications/Chess.app'],
      [
        'neondrift',
        '/Users/alex/Library/Application Support/Steam/steamapps/common/Neon Drift/NeonDrift.app',
      ],
      ['safari', '/Applications/Safari.app'],
    ]);
  });

  it('still lists everything when asked for every process', async () => {
    const names = (await mac.listRunningProcesses(false)).map((p) => p.name);
    expect(names).toContain('xprotect');
    expect(names).toContain('sharkdeck helper (renderer)');
    // SYSTEM_NOISE still applies either way
    expect(names).not.toContain('launchd');
    expect(names).not.toContain('sharkdeck');
  });
});
