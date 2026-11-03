import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwitchApplication } from '@shared/types/profiles';

/**
 * The auto-switch card's window handling. Three things went wrong with it in
 * use, all of them timing: the first card of a session painted empty (shown
 * before its page could take the content), a game that went fullscreen just
 * after the switch covered the card for its whole ten seconds, and the card
 * could not tell the pointer was near it (the window ignores the mouse).
 */

/** Just enough BrowserWindow to watch what overlayWindow.ts does with one. */
class FakeWindow {
  static all: FakeWindow[] = [];
  readonly calls: string[] = [];
  readonly sent: Array<[string, unknown]> = [];
  private readonly pageEvents = new Map<string, () => void>();
  private visible = false;
  private destroyed = false;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  readonly webContents = {
    setWindowOpenHandler: () => undefined,
    on: (event: string, fn: () => void) => void this.pageEvents.set(event, fn),
    send: (channel: string, data: unknown) => void this.sent.push([channel, data]),
  };
  constructor() {
    FakeWindow.all.push(this);
  }
  /** Test helper: the page finished loading. */
  load(): void {
    this.pageEvents.get('did-finish-load')?.();
  }
  setAlwaysOnTop() {
    this.calls.push('onTop');
  }
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents() {}
  loadFile() {
    return Promise.resolve();
  }
  on() {}
  isDestroyed() {
    return this.destroyed;
  }
  setBounds(b: { x: number; y: number; width: number; height: number }) {
    this.bounds = b;
  }
  getBounds() {
    return this.bounds;
  }
  setOpacity() {}
  showInactive() {
    this.visible = true;
    this.calls.push('show');
  }
  moveTop() {
    this.calls.push('moveTop');
  }
  isVisible() {
    return this.visible;
  }
  hide() {
    this.visible = false;
    this.calls.push('hide');
  }
  destroy() {
    this.destroyed = true;
  }
}

let cursor = { x: 0, y: 0 };
const pathForRunningExe = vi.fn(async (_exe: string): Promise<string | null> => null);
const iconFor = vi.fn(async (_path: string): Promise<string | null> => null);

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  app: { getAppPath: () => '/app' },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => cursor,
  },
}));
vi.mock('./settings', () => ({
  getSettingsSync: () => ({ overlayEnabled: true, language: 'en' }),
}));
vi.mock('./profiles/processScan', () => ({
  pathForRunningExe: (exe: string) => pathForRunningExe(exe),
}));
const bigIconFor = vi.fn(async (_path: string): Promise<string | null> => null);
vi.mock('./profiles/processIcons', () => ({
  iconFor: (p: string) => iconFor(p),
  bigIconFor: (p: string) => bigIconFor(p),
}));

const { showSwitchOverlay, destroySwitchOverlay } = await import('./overlayWindow');

const SWITCH = (over: Partial<SwitchApplication> = {}): SwitchApplication => ({
  at: 1,
  profileId: 'gaming',
  profileName: 'Gaming',
  reason: 'game',
  context: 'cs2.exe',
  exeIcon: 'data:image/png;base64,AAAA',
  devices: [],
  ...over,
});

interface Content {
  mode: string;
  exe: string;
  exeIcon: string | null;
}
const contents = (w: FakeWindow) =>
  w.sent.filter(([ch]) => ch === 'overlay:content').map(([, d]) => d as Content);
const pointers = (w: FakeWindow) =>
  w.sent.filter(([ch]) => ch === 'overlay:pointer').map(([, d]) => d);
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Show one card on a page that has loaded, and hand back its window. */
function shown(app = SWITCH()): FakeWindow {
  showSwitchOverlay(app);
  const w = FakeWindow.all.at(-1)!;
  w.load();
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWindow.all = [];
  cursor = { x: 0, y: 0 };
  pathForRunningExe.mockReset().mockResolvedValue(null);
  iconFor.mockReset().mockResolvedValue(null);
  bigIconFor.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  destroySwitchOverlay();
  vi.useRealTimers();
});

describe('the auto-switch card', () => {
  it('says the mode and the game, with its icon, and nothing else', () => {
    const w = shown();
    expect(contents(w)[0]).toEqual({
      id: 1,
      kind: 'game',
      ms: 10_000,
      logo: expect.any(String),
      brand: 'Shark Deck',
      mode: 'Gaming mode',
      exe: 'cs2.exe',
      exeIcon: 'data:image/png;base64,AAAA',
    });
  });

  it("swaps in the game's bigger icon once it is found", async () => {
    pathForRunningExe.mockResolvedValue('C:/Games/cs2.exe');
    bigIconFor.mockResolvedValue('data:image/png;base64,BIG');
    const w = shown();
    await flush();
    expect(contents(w).at(-1)).toMatchObject({ id: 1, exeIcon: 'data:image/png;base64,BIG' });
    expect(iconFor).not.toHaveBeenCalled();
  });

  it('names what exited on the way back to the desktop, or nothing', () => {
    const w = shown(SWITCH({ reason: 'desktop', profileName: 'Desktop' }));
    expect(contents(w).at(-1)).toMatchObject({
      mode: 'Desktop mode',
      exe: 'Exited cs2.exe',
    });
    showSwitchOverlay(SWITCH({ at: 2, reason: 'desktop', profileName: 'Desktop', context: '' }));
    expect(contents(w).at(-1)).toMatchObject({ exe: '', exeIcon: null });
  });

  it('waits for its page before showing the first card', () => {
    showSwitchOverlay(SWITCH());
    const w = FakeWindow.all[0]!;
    expect(w.calls).not.toContain('show');
    expect(contents(w)).toEqual([]);

    w.load();
    expect(contents(w)).toHaveLength(1);
    expect(w.calls).toContain('show');
  });

  it('keeps itself on top for its ten seconds, then goes', () => {
    const w = shown();
    w.calls.length = 0;
    vi.advanceTimersByTime(3000);
    // Put back on top every second, the level re-asserted each time.
    expect(w.calls.filter((c) => c === 'moveTop')).toHaveLength(3);
    expect(w.calls.filter((c) => c === 'onTop')).toHaveLength(3);

    vi.advanceTimersByTime(7000 + 400); // the rest of DISPLAY_MS, and the fade
    expect(w.calls).toContain('hide');
    const settled = w.calls.length;
    vi.advanceTimersByTime(5000);
    expect(w.calls).toHaveLength(settled); // nothing raises a card that has gone
  });

  it('reports the pointer while showing, only when it moved', () => {
    // The window's corner: 1920 - 300 - 24, 1040 - 160 - 24.
    cursor = { x: 1640, y: 900 };
    const w = shown();
    vi.advanceTimersByTime(200);
    expect(pointers(w)).toEqual([{ x: 44, y: 44 }]);

    cursor = { x: 1440, y: 900 };
    vi.advanceTimersByTime(60);
    expect(pointers(w)).toEqual([
      { x: 44, y: 44 },
      { x: -156, y: 44 },
    ]);

    vi.advanceTimersByTime(11_000); // gone
    cursor = { x: 0, y: 0 };
    vi.advanceTimersByTime(500);
    expect(pointers(w)).toHaveLength(2);
  });

  it('lets only inline images onto the card', () => {
    const w = shown(SWITCH({ exeIcon: 'file:///C:/Users/me/picture.png' }));
    expect(contents(w)[0]?.exeIcon).toBeNull();
  });

  it('puts a late-found icon only on the card it was looked up for', async () => {
    const answer = new Map<string, (p: string) => void>();
    pathForRunningExe.mockImplementation(
      (exe: string) => new Promise<string | null>((r) => answer.set(exe, r)),
    );
    iconFor.mockImplementation(async (p: string) => `data:image/png;base64,${p}`);

    const w = shown(SWITCH({ at: 1, exeIcon: null }));
    // A second switch lands before the first lookup answers.
    showSwitchOverlay(SWITCH({ at: 2, exeIcon: null, context: 'other.exe' }));

    answer.get('cs2.exe')!('CS2');
    await flush();
    expect(contents(w).some((c) => c.exeIcon?.endsWith('CS2'))).toBe(false);

    answer.get('other.exe')!('OTHER');
    await flush();
    expect(contents(w).at(-1)).toMatchObject({
      exe: 'other.exe',
      exeIcon: 'data:image/png;base64,OTHER',
    });
  });
});
