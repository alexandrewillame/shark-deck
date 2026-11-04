import { mixPalette, readPalette, samePalette, type BgPalette } from './palette';
import { BACKGROUNDS, type BackgroundDef, type DrawnEffect } from './registry';
import { BackgroundRenderer, type FrameSink } from './renderer';

/** What the layer is told by settings. */
export interface LayerSettings {
  effect: DrawnEffect;
  usePalette: boolean;
  /** 0-100, as stored. */
  intensity: number;
  animate: boolean;
}

/** How the layer gets a renderer — a test passes a counter instead. */
export type SinkFactory = (canvas: HTMLCanvasElement) => FrameSink | null;

/** The theme cross-fade's length (`THEME_ANIM_MS` in state/theme.ts). */
const FADE_MS = 400;
/** Past 2x a background only costs more: nobody sees a smoke plume sharpen. */
const MAX_DPR = 2;
/** The most pixels a frame is drawn at, about a 2560x1600 screen's worth.
 *  Every one is shaded again each frame, and re-blurred behind every frosted
 *  panel; past this a big window draws slightly softer instead of slower. */
const MAX_PIXELS = 4_100_000;

/**
 * The background behind the app: one canvas, one renderer, and the loop that
 * decides when to draw.
 *
 * It draws as little as it can get away with. A frame is drawn when something
 * changed (the window, the palette, a setting) or, while the effect is
 * MOVING, at the effect's own rate. It is not moving — so it draws one still
 * frame and stops — when Animate is off (which, until the switch is first
 * set, is what the system's reduced-motion setting says: motion.ts), when the
 * GPU is a software rasteriser, and while the window is hidden. Time only
 * passes while it moves, so a background that stops and starts again carries
 * on where it was.
 *
 * A lost context (a GPU reset, a driver update) holds the loop until the
 * context comes back, then starts again from scratch.
 *
 * Everything it listens to is let go in `dispose()`.
 */
export class BackgroundLayerController {
  private canvas: HTMLCanvasElement | null = null;
  private sink: FrameSink | null = null;
  private s: LayerSettings;
  private def: BackgroundDef;
  private time: number;
  private palette: BgPalette;
  private fadeFrom: BgPalette | null = null;
  private fadeTo: BgPalette;
  private fadeStart = 0;
  private dirty = true;
  private raf = 0;
  private last = 0;
  private lastDraw = -Infinity;
  private failed = false;
  private lost = false;
  private cleanup: Array<() => void> = [];

  constructor(
    private readonly host: HTMLElement,
    settings: LayerSettings,
    private readonly make: SinkFactory = (c) => BackgroundRenderer.create(c),
  ) {
    this.s = settings;
    this.def = BACKGROUNDS[settings.effect];
    this.time = this.def.still;
    this.palette = readPalette();
    this.fadeTo = this.palette;
  }

  /** False when there is no WebGL — the page keeps its own background. */
  start(): boolean {
    const canvas = document.createElement('canvas');
    canvas.className = 'bg-canvas';
    const sink = this.make(canvas);
    if (!sink) return false;
    this.host.appendChild(canvas);
    this.canvas = canvas;
    this.sink = sink;

    const on = <K extends string>(target: EventTarget, type: K, fn: (e: Event) => void): void => {
      target.addEventListener(type, fn);
      this.cleanup.push(() => target.removeEventListener(type, fn));
    };
    on(window, 'resize', () => this.invalidate());
    on(document, 'visibilitychange', () => this.kick());
    on(canvas, 'webglcontextlost', (e) => {
      // Asking for it back: without preventDefault the context stays lost.
      e.preventDefault();
      this.lost = true;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    });
    on(canvas, 'webglcontextrestored', () => {
      // A draw that ran into the lost context before this event arrived
      // marked the layer failed; that was the context, not the effect.
      this.lost = false;
      this.failed = false;
      this.sink?.reset();
      this.invalidate();
    });
    // A palette change lands on <html> (state/theme.ts). A light/dark change
    // does not reach the background at all: it is a night sky in both themes,
    // drawn in the palette's `--night-*` colours (palette.ts).
    const observer = new MutationObserver(() => this.onTheme());
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-palette'],
    });
    this.cleanup.push(() => observer.disconnect());

    this.size();
    this.kick();
    return true;
  }

  update(next: LayerSettings): void {
    const prev = this.s;
    this.s = next;
    if (next.effect !== prev.effect) {
      this.def = BACKGROUNDS[next.effect];
      this.time = this.def.still;
      this.failed = false;
      this.size();
    }
    this.invalidate();
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const fn of this.cleanup.splice(0)) fn();
    this.sink?.dispose();
    this.sink = null;
    this.canvas?.remove();
    this.canvas = null;
  }

  /** Whether the effect is moving right now — see the class comment. */
  get moving(): boolean {
    return this.s.animate && !this.sink?.software && !document.hidden;
  }

  private onTheme(): void {
    const next = readPalette();
    if (samePalette(next, this.fadeTo)) return;
    this.fadeFrom = this.palette;
    this.fadeTo = next;
    this.fadeStart = performance.now();
    this.kick();
  }

  private invalidate(): void {
    this.size();
    this.dirty = true;
    this.kick();
  }

  /** The drawing buffer: the window in device pixels, times the effect's
   *  scale, within `MAX_PIXELS`. CSS stretches it back over the window. */
  private size(): void {
    const c = this.canvas;
    if (!c) return;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const want = window.innerWidth * window.innerHeight * (dpr * this.def.scale) ** 2;
    const k = dpr * this.def.scale * Math.min(1, Math.sqrt(MAX_PIXELS / Math.max(1, want)));
    const w = Math.max(1, Math.round(window.innerWidth * k));
    const h = Math.max(1, Math.round(window.innerHeight * k));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
      this.dirty = true;
    }
  }

  private kick(): void {
    if (!this.raf && this.sink && !this.failed && !this.lost) {
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private frame = (now: number): void => {
    this.raf = 0;
    const sink = this.sink;
    if (!sink || this.failed) return;

    const moving = this.moving;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = moving ? now : 0;
    if (moving) this.time += dt;

    let fading = false;
    if (this.fadeFrom) {
      const k = (now - this.fadeStart) / FADE_MS;
      if (k >= 1) {
        this.palette = this.fadeTo;
        this.fadeFrom = null;
      } else {
        this.palette = mixPalette(this.fadeFrom, this.fadeTo, k);
        fading = true;
      }
      this.dirty = true;
    }

    const due = moving && now - this.lastDraw >= 1000 / this.def.fps - 2;
    let compiling = false;
    if (this.dirty || due) {
      const result = sink.draw({
        def: this.def,
        time: this.time,
        palette: this.palette,
        usePalette: this.s.usePalette,
        intensity: this.s.intensity / 100,
      });
      if (result === 'failed') {
        // A shader that will not compile, or a context that went away: stop,
        // and leave the page its own background rather than a black window.
        this.failed = true;
        this.canvas?.classList.remove('is-ready');
        return;
      }
      if (result === 'drawn') {
        this.canvas?.classList.add('is-ready');
        this.lastDraw = now;
        this.dirty = false;
      } else {
        // Still compiling, off the main thread: the last frame stays up (the
        // previous effect's, or nothing yet) and this asks again next frame.
        compiling = true;
      }
    }
    if (moving || fading || compiling) this.raf = requestAnimationFrame(this.frame);
  };
}
