import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types/app-settings';
import { useStore } from '../state/store';
import { applyTheme } from '../state/theme';
import { BackgroundLayer } from './BackgroundLayer';
import type { FrameParams, FrameSink } from './renderer';
import { setLiveIntensity } from './live';

/**
 * The background layer with a renderer that only counts: what it draws and
 * how often, which is the part that costs — a background that redraws when
 * nothing moves, or keeps going when it should hold still, is a GPU burning
 * for nothing behind every frosted panel.
 */

const settings = (over: Partial<AppSettings>): AppSettings =>
  ({
    palette: 'shark-cyan',
    themeMode: 'dark',
    background: 'smoke',
    backgroundPalette: true,
    backgroundIntensity: 60,
    backgroundAnimate: true,
    ...over,
  }) as AppSettings;

function counter() {
  const frames: FrameParams[] = [];
  let disposed = 0;
  const sink: FrameSink = {
    software: false,
    draw: (p) => {
      frames.push(p);
      return 'drawn';
    },
    reset: () => undefined,
    dispose: () => void disposed++,
  };
  return { sink, frames, disposed: () => disposed, make: vi.fn(() => sink) };
}

const g = globalThis as unknown as { matchMedia: (q: string) => unknown };
const realMatchMedia = g.matchMedia;
const reducedMotion = (on: boolean) => {
  g.matchMedia = (query: string) => ({
    matches: on && query.includes('reduced-motion'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
};

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => reducedMotion(false));
afterEach(() => {
  g.matchMedia = realMatchMedia;
  setLiveIntensity(null);
  useStore.setState({ settings: null });
});

describe('BackgroundLayer', () => {
  it('draws nothing at all for no background', () => {
    useStore.setState({ settings: settings({ background: 'none' }) });
    const c = counter();
    const { container } = render(<BackgroundLayer makeSink={c.make} />);
    expect(container.innerHTML).toBe('');
    expect(c.make).not.toHaveBeenCalled();
  });

  it('leaves the page its own background when there is no WebGL', async () => {
    useStore.setState({ settings: settings({}) });
    const { container } = render(<BackgroundLayer makeSink={() => null} />);
    await wait(50);
    expect(container.querySelector('.bg-layer')).not.toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('keeps drawing while it moves, in the palette, at the stored intensity', async () => {
    useStore.setState({ settings: settings({}) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(250);
    expect(c.frames.length).toBeGreaterThan(2);
    const last = c.frames.at(-1)!;
    expect(last.def.id).toBe('smoke');
    expect(last.usePalette).toBe(true);
    expect(last.intensity).toBeCloseTo(0.6);
    // Time moves on between frames.
    expect(last.time).toBeGreaterThan(c.frames[0]!.time);
  });

  it('holds one still frame where the system asks for reduced motion, until Animate is set', async () => {
    reducedMotion(true);
    useStore.setState({ settings: settings({ backgroundAnimate: undefined }) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(250);
    expect(c.frames).toHaveLength(1);
  });

  it('moves under reduced motion once Animate is switched on', async () => {
    // Reported: "all background animations are stopped, even if the animate
    // button is on" — Windows' Animation effects were off, and the system's
    // reduced motion overruled the app's own switch.
    reducedMotion(true);
    useStore.setState({ settings: settings({ backgroundAnimate: true }) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(250);
    expect(c.frames.length).toBeGreaterThan(2);
  });

  it('moves with Animate unset where the system does not ask for reduced motion', async () => {
    useStore.setState({ settings: settings({ backgroundAnimate: undefined }) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(250);
    expect(c.frames.length).toBeGreaterThan(2);
  });

  it('holds one frame with Animate off', async () => {
    useStore.setState({ settings: settings({ backgroundAnimate: false }) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(200);
    expect(c.frames).toHaveLength(1);
  });

  it('keeps moving when the palette colours are switched off', async () => {
    // Reported: "when I disable color palette, it stopped animating".
    useStore.setState({ settings: settings({ background: 'rain' }) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(120);
    act(() =>
      useStore.setState({
        settings: settings({ background: 'rain', backgroundPalette: false }),
      }),
    );
    await wait(50);
    const from = c.frames.length;
    const t0 = c.frames.at(-1)!.time;
    await wait(200);
    expect(c.frames.length).toBeGreaterThan(from + 2);
    expect(c.frames.at(-1)!.usePalette).toBe(false);
    expect(c.frames.at(-1)!.time).toBeGreaterThan(t0);
  });

  it('follows the intensity slider live, without starting over', async () => {
    useStore.setState({ settings: settings({ backgroundAnimate: false }) });
    const c = counter();
    render(<BackgroundLayer makeSink={c.make} />);
    await wait(50);
    act(() => setLiveIntensity(90));
    await wait(50);
    expect(c.frames.at(-1)!.intensity).toBeCloseTo(0.9);
    expect(c.make).toHaveBeenCalledTimes(1);
  });

  it('switches effect on the same canvas, and lets go of it when turned off', async () => {
    useStore.setState({ settings: settings({ backgroundAnimate: false }) });
    const c = counter();
    const { container } = render(<BackgroundLayer makeSink={c.make} />);
    await wait(50);
    act(() =>
      useStore.setState({ settings: settings({ background: 'fire', backgroundAnimate: false }) }),
    );
    await wait(50);
    expect(c.frames.at(-1)!.def.id).toBe('fire');
    expect(c.make).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ settings: settings({ background: 'none' }) }));
    expect(c.disposed()).toBe(1);
    expect(container.querySelector('canvas')).toBeNull();
  });

  it('comes back after a lost context, even when a frame ran into it first', async () => {
    // A context is lost at once, but the event saying so arrives later: a
    // frame in between fails, and that used to switch the layer off for good.
    useStore.setState({ settings: settings({ backgroundAnimate: false }) });
    let result: 'drawn' | 'failed' = 'drawn';
    let resets = 0;
    const frames: FrameParams[] = [];
    const sink: FrameSink = {
      software: false,
      draw: (p) => {
        frames.push(p);
        return result;
      },
      reset: () => void resets++,
      dispose: () => undefined,
    };
    const make = () => sink;
    const { container } = render(<BackgroundLayer makeSink={make} />);
    await wait(50);
    const canvas = container.querySelector('canvas')!;
    expect(canvas.classList.contains('is-ready')).toBe(true);

    result = 'failed';
    act(() => setLiveIntensity(80));
    await wait(50);
    expect(canvas.classList.contains('is-ready')).toBe(false);

    act(() => void canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
    result = 'drawn';
    act(() => void canvas.dispatchEvent(new Event('webglcontextrestored')));
    await wait(50);
    expect(resets).toBe(1);
    expect(canvas.classList.contains('is-ready')).toBe(true);
    expect(frames.at(-1)!.intensity).toBeCloseTo(0.8);
  });
});

describe('applyTheme', () => {
  afterEach(() => applyTheme({ palette: 'shark-cyan', themeMode: 'dark', background: 'none' }));

  it('marks <html> while a background is on — the frosted panels key off it', () => {
    applyTheme({ palette: 'red', themeMode: 'dark', background: 'nebula' });
    expect(document.documentElement.dataset.bg).toBe('nebula');
    applyTheme({ palette: 'red', themeMode: 'dark', background: 'none' });
    expect(document.documentElement.dataset.bg).toBeUndefined();
  });
});
