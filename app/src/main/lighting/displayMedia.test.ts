import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How main answers getDisplayMedia() (Screen Colour / Music lighting).
 *
 * Every refusal must be `callback(null)`. `callback({})` throws in Electron 38
 * when video was requested ("Video was requested, but no video stream was
 * provided"), and on macOS 26 that was the first Screen Colour every time:
 * with Screen Recording not yet granted, getSources() lists no screen, so the
 * handler refused — and the throw put up the crash window.
 *
 * And getSources() runs a tick after the handler is called, never inside it:
 * its rejection (no permission) otherwise reached 'unhandledRejection' before
 * the handler's own .catch — the second crash window, behind the first.
 */

type Handler = (request: unknown, callback: (streams: unknown) => void) => void;

const h = vi.hoisted(() => ({
  handler: null as Handler | null,
  armed: true,
  sources: [] as Array<{ id: string }>,
  fail: null as Error | null,
  onGetSources: null as null | (() => void),
}));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      setDisplayMediaRequestHandler: (fn: Handler) => {
        h.handler = fn;
      },
    },
  },
  desktopCapturer: {
    // Not async: the call itself is what the timing test watches.
    getSources: () => {
      h.onGetSources?.();
      return h.fail ? Promise.reject(h.fail) : Promise.resolve(h.sources);
    },
  },
}));
vi.mock('./ambient', () => ({ captureArmed: () => h.armed }));

const { installDisplayMediaHandler } = await import('./displayMedia');
installDisplayMediaHandler();

/** One getDisplayMedia({ video: true, audio: true }) from the renderer. */
function ask(): Promise<unknown> {
  return new Promise((resolve) =>
    h.handler!({ videoRequested: true, audioRequested: true }, resolve),
  );
}

beforeEach(() => {
  h.armed = true;
  h.sources = [];
  h.fail = null;
  h.onGetSources = null;
});

describe('the display-media handler', () => {
  it('refuses with null when no ambient effect is running', async () => {
    h.armed = false;
    expect(await ask()).toBeNull();
  });

  it('refuses with null when there is no screen to capture (macOS before Screen Recording)', async () => {
    expect(await ask()).toBeNull();
  });

  it('refuses with null when the screens cannot be listed', async () => {
    h.fail = new Error('not permitted');
    expect(await ask()).toBeNull();
  });

  it('lists the screens only once the handler has returned', async () => {
    h.sources = [{ id: 'screen:1:0' }];
    let inside = false;
    const calls: boolean[] = [];
    h.onGetSources = () => calls.push(inside);
    const answered = new Promise((resolve) => {
      inside = true;
      h.handler!({ videoRequested: true, audioRequested: true }, resolve);
      inside = false;
    });
    await answered;
    expect(calls).toEqual([false]);
  });

  it('grants the first screen, with system audio only on Windows', async () => {
    h.sources = [{ id: 'screen:1:0' }];
    expect(await ask()).toEqual(
      process.platform === 'win32'
        ? { video: { id: 'screen:1:0' }, audio: 'loopback' }
        : { video: { id: 'screen:1:0' } },
    );
  });
});
