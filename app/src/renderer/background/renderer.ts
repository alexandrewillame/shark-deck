import type { BgPalette } from './palette';
import type { BackgroundDef, DrawnEffect } from './registry';
import { COMMON } from './shaders/common';

/** One frame's worth of input. */
export interface FrameParams {
  def: BackgroundDef;
  /** Seconds of animation. */
  time: number;
  palette: BgPalette;
  /** Draw in the palette's colours rather than the effect's own. */
  usePalette: boolean;
  /** 0..1 */
  intensity: number;
}

/** A draw's outcome. `pending`: the effect's shader is still compiling, off
 *  the main thread — ask again next frame. */
export type DrawResult = 'drawn' | 'pending' | 'failed';

/** What draws frames — the WebGL renderer below, or a test's counter. */
export interface FrameSink {
  /** A software rasteriser: a still frame only, never a loop. */
  readonly software: boolean;
  draw(p: FrameParams): DrawResult;
  /** After a lost context comes back, everything on the GPU is gone. */
  reset(): void;
  dispose(): void;
}

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const UNIFORMS = ['uRes', 'uTime', 'uA', 'uB', 'uBg', 'uLight', 'uIntensity', 'uPal'] as const;
type Uniform = (typeof UNIFORMS)[number];

interface Program {
  prog: WebGLProgram;
  pos: number;
  loc: Record<Uniform, WebGLUniformLocation | null>;
}

/** One effect's program on its way to being usable. */
interface Entry {
  prog: WebGLProgram | null;
  vs: WebGLShader | null;
  fs: WebGLShader | null;
  ready: Program | null;
  failed: boolean;
}

/** `KHR_parallel_shader_compile`, which lib.dom does not type. */
interface ParallelCompile {
  readonly COMPLETION_STATUS_KHR: number;
}

/** A renderer string that means no GPU at all: drawing every frame in
 *  software would load a CPU core to animate a background. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

/**
 * WebGL 1 plumbing for the backgrounds: one full-window triangle, one program
 * per effect (compiled on first use and kept), eight uniforms.
 *
 * WebGL 1 rather than 2 for reach. Nothing here needs more, and a background
 * that fails to start just leaves the plain theme — `create` returns null and
 * the caller keeps `.app`'s own gradient.
 *
 * Shaders compile in the background where the GPU offers
 * `KHR_parallel_shader_compile` (Chromium does): a program is started, and
 * `draw` answers `pending` until it is done. Compiled the ordinary way, these
 * shaders take 0.2-0.6 s each, all of it a frozen window — once per effect,
 * and nine times over when the picker draws its thumbnails.
 */
export class BackgroundRenderer implements FrameSink {
  readonly software: boolean;
  private entries = new Map<string, Entry>();
  private buffer: WebGLBuffer | null = null;
  private parallel: ParallelCompile | null;

  static create(
    canvas: HTMLCanvasElement,
    opts: { preserve?: boolean } = {},
  ): BackgroundRenderer | null {
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: !!opts.preserve,
        powerPreference: 'low-power',
      }) as WebGLRenderingContext | null;
    } catch {
      gl = null;
    }
    return gl ? new BackgroundRenderer(gl) : null;
  }

  private constructor(private readonly gl: WebGLRenderingContext) {
    let name = '';
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      name = String(
        (info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER),
      );
    } catch {
      /* no name: assume hardware */
    }
    this.software = SOFTWARE.test(name);
    this.parallel = this.extensions();
  }

  /** The GPU let go of this context (a reset, a driver update). */
  get lost(): boolean {
    return this.gl.isContextLost();
  }

  /** Shaders build off the main thread (`KHR_parallel_shader_compile`); without
   *  it, every `prepare` that finishes one blocks for the whole compile. */
  get compilesInBackground(): boolean {
    return !!this.parallel;
  }

  reset(): void {
    this.entries.clear();
    this.buffer = null;
    // A restored context starts with no extensions: ask again, or every
    // program reads as still compiling and `slope()` as flat.
    this.parallel = this.extensions();
  }

  /** Turn on what the shaders use, before anything compiles: in WebGL 1 an
   *  extension exists for a shader only once it has been asked for. Without
   *  derivatives common.ts's `slope()` reads a flat surface; without parallel
   *  compiling, `prepare` compiles the blocking way. */
  private extensions(): ParallelCompile | null {
    this.gl.getExtension('OES_standard_derivatives');
    return this.gl.getExtension('KHR_parallel_shader_compile') as ParallelCompile | null;
  }

  /** Start compiling the effect's program if nothing has, and say where it
   *  stands. Never blocks while a parallel compile is still running. */
  prepare(def: BackgroundDef): 'ready' | 'pending' | 'failed' {
    const gl = this.gl;
    // A lost context answers every query with null, which reads as "still
    // compiling" below — forever.
    if (gl.isContextLost()) return 'failed';
    let e = this.entries.get(def.id);
    if (!e) {
      e = this.begin(def);
      this.entries.set(def.id, e);
    }
    if (e.failed) return 'failed';
    if (e.ready) return 'ready';
    if (
      this.parallel &&
      e.prog &&
      !gl.getProgramParameter(e.prog, this.parallel.COMPLETION_STATUS_KHR)
    ) {
      return 'pending';
    }
    this.finish(def, e);
    return e.ready ? 'ready' : 'failed';
  }

  draw(p: FrameParams): DrawResult {
    const gl = this.gl;
    if (gl.isContextLost()) return 'failed';
    const state = this.prepare(p.def);
    if (state !== 'ready') return state;
    const prog = this.entries.get(p.def.id)!.ready!;
    if (!this.buffer) {
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      // One triangle that covers the whole viewport (and more).
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    }
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(prog.pos);
    gl.vertexAttribPointer(prog.pos, 2, gl.FLOAT, false, 0, 0);

    const [a, b] = p.usePalette
      ? [p.palette.accent, p.palette.secondary]
      : p.palette.light
        ? p.def.natural.light
        : p.def.natural.dark;
    gl.uniform2f(prog.loc.uRes, w, h);
    gl.uniform1f(prog.loc.uTime, p.time);
    gl.uniform3fv(prog.loc.uA, a);
    gl.uniform3fv(prog.loc.uB, b);
    gl.uniform3fv(prog.loc.uBg, p.palette.base);
    gl.uniform1f(prog.loc.uLight, p.palette.light ? 1 : 0);
    gl.uniform1f(prog.loc.uIntensity, Math.min(1, Math.max(0, p.intensity)));
    gl.uniform1f(prog.loc.uPal, p.usePalette ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return 'drawn';
  }

  dispose(): void {
    const gl = this.gl;
    try {
      for (const e of this.entries.values()) {
        if (e.prog) gl.deleteProgram(e.prog);
        if (e.vs) gl.deleteShader(e.vs);
        if (e.fs) gl.deleteShader(e.fs);
      }
      if (this.buffer) gl.deleteBuffer(this.buffer);
      // Hand the context back now rather than at the next garbage collection:
      // Chromium caps live WebGL contexts at 16 and drops the oldest.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* already gone */
    }
    this.entries.clear();
    this.buffer = null;
  }

  /** Compile and link, without asking how it went — asking is what blocks. */
  private begin(def: BackgroundDef): Entry {
    const gl = this.gl;
    const shader = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX);
    const fs = shader(gl.FRAGMENT_SHADER, COMMON + def.frag);
    const prog = vs && fs ? gl.createProgram() : null;
    if (prog && vs && fs) {
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
    }
    return { prog, vs, fs, ready: null, failed: !prog };
  }

  /** The compile is done: did it work? A program that will not build is
   *  remembered as failed, so it costs one warning rather than one a frame. */
  private finish(def: BackgroundDef, e: Entry): void {
    const gl = this.gl;
    if (e.prog && gl.getProgramParameter(e.prog, gl.LINK_STATUS)) {
      const loc = {} as Program['loc'];
      for (const u of UNIFORMS) loc[u] = gl.getUniformLocation(e.prog, u);
      e.ready = { prog: e.prog, pos: gl.getAttribLocation(e.prog, 'aPos'), loc };
    } else {
      const why =
        (e.fs && gl.getShaderInfoLog(e.fs)) ||
        (e.vs && gl.getShaderInfoLog(e.vs)) ||
        (e.prog && gl.getProgramInfoLog(e.prog)) ||
        'did not build';
      console.warn(`background "${def.id}": ${why}`);
      if (e.prog) gl.deleteProgram(e.prog);
      e.prog = null;
      e.failed = true;
    }
    if (e.vs) gl.deleteShader(e.vs);
    if (e.fs) gl.deleteShader(e.fs);
    e.vs = null;
    e.fs = null;
  }
}

let thumbCanvas: HTMLCanvasElement | null = null;
let thumbSink: BackgroundRenderer | null | undefined;
const thumbs = new Map<string, string | null>();

function thumbRenderer(): BackgroundRenderer | null {
  // Nothing listens for this canvas's context coming back, so a lost one is
  // replaced rather than waited on.
  if (thumbSink?.lost) {
    thumbSink.dispose();
    thumbSink = undefined;
  }
  if (thumbSink === undefined) {
    thumbCanvas = document.createElement('canvas');
    thumbSink = BackgroundRenderer.create(thumbCanvas, { preserve: true });
  }
  return thumbSink;
}

/** One tile: the effect's still moment, as a PNG data URL. */
function drawTile(
  r: BackgroundRenderer,
  def: BackgroundDef,
  palette: BgPalette,
  usePalette: boolean,
  width: number,
  height: number,
): string | null {
  if (!thumbCanvas) return null;
  thumbCanvas.width = width;
  thumbCanvas.height = height;
  if (r.draw({ def, time: def.still, palette, usePalette, intensity: 0.9 }) !== 'drawn')
    return null;
  try {
    return thumbCanvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

/**
 * Stills of the backgrounds, as image URLs, for the picker — each handed to
 * `onTile` as soon as its own shader is ready, in whatever order they finish.
 * Taken in the picker's order, every tile after Electricity waited on its
 * shader, which alone takes about two seconds to build on a Direct3D GPU.
 *
 * Drawn by ONE renderer kept for the purpose — ten small canvases with a
 * context each would spend nine of the sixteen live contexts Chromium allows —
 * and cached by everything that changes the picture, so asking again for the
 * same look answers at once. The CSP allows `data:` images. A tile that
 * cannot be drawn (no WebGL, a shader that will not build) comes back null:
 * the picker shows a plain one. Returns a function that stops the deliveries.
 */
export function thumbnails(
  defs: readonly BackgroundDef[],
  palette: BgPalette,
  usePalette: boolean,
  width: number,
  height: number,
  onTile: (id: DrawnEffect, url: string | null) => void,
): () => void {
  const waiting = new Set(defs);
  let raf = 0;
  const step = () => {
    raf = 0;
    const r = thumbRenderer();
    // Without background compiling, finishing a shader blocks for the whole
    // compile: one a frame, so the window keeps answering.
    let budget = r && !r.compilesInBackground ? 1 : Infinity;
    for (const def of [...waiting]) {
      const key = JSON.stringify([def.id, palette, usePalette, width, height]);
      let url = thumbs.get(key);
      if (url === undefined) {
        if (budget <= 0) continue;
        const state = r ? r.prepare(def) : 'failed';
        if (state === 'pending') continue;
        budget--;
        url = r && state === 'ready' ? drawTile(r, def, palette, usePalette, width, height) : null;
        // One lost with its context is drawn again next time, not kept blank.
        if (!r?.lost) thumbs.set(key, url);
      }
      waiting.delete(def);
      onTile(def.id, url);
    }
    if (waiting.size) raf = requestAnimationFrame(step);
  };
  step();
  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    waiting.clear();
  };
}
