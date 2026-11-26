import { BACKGROUND_EFFECTS, type BackgroundEffect } from '@shared/backgrounds';
import type { MessageKey } from '@shared/i18n';
import type { Rgb } from './palette';
import { AURORA, LANDSCAPE, NEBULA, SMOKE, WATER } from './shaders/effects';

/** A background that is drawn — every one but `none`. */
export type DrawnEffect = Exclude<BackgroundEffect, 'none'>;

export interface BackgroundDef {
  id: DrawnEffect;
  labelKey: MessageKey;
  /** Frames per second while it moves. Smoke and clouds drift; nothing here
   *  gains from 60, and every frame is also re-blurred behind every panel. */
  fps: number;
  /** The drawing buffer as a fraction of the window's device pixels — 1 for
   *  anything with an edge in it (bolts, ridges, the lace between paints),
   *  a little less for what is soft all over. Drawn smaller, every line came
   *  out blurred ("the backgrounds look low resolution"). The layer also caps
   *  the buffer's size on a very large window (`MAX_PIXELS`, layer.ts). */
  scale: number;
  /** The moment a still frame shows — with reduced motion, with Animate off,
   *  and in the picker's thumbnail — chosen to be a good-looking one. */
  still: number;
  /** Its own colours, for when "Use palette colours" is off: [main, second].
   *  One pair for night and day: the daylight version lights the same two. */
  natural: [Rgb, Rgb];
  /** The fragment shader's `main()`, after shaders/common.ts. */
  frag: string;
}

const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb;

export const BACKGROUNDS: Record<DrawnEffect, BackgroundDef> = {
  smoke: {
    id: 'smoke',
    labelKey: 'set.background.smoke',
    fps: 30,
    scale: 0.75,
    still: 24,
    natural: [hex('#a9b8c8'), hex('#64707e')],
    frag: SMOKE,
  },
  aurora: {
    id: 'aurora',
    labelKey: 'set.background.aurora',
    fps: 30,
    scale: 0.75,
    still: 18,
    natural: [hex('#38f08f'), hex('#8a5cff')],
    frag: AURORA,
  },
  nebula: {
    id: 'nebula',
    labelKey: 'set.background.nebula',
    fps: 24,
    scale: 0.9,
    still: 40,
    natural: [hex('#e05ac0'), hex('#3d6bff')],
    frag: NEBULA,
  },
  landscape: {
    id: 'landscape',
    labelKey: 'set.background.landscape',
    fps: 12,
    scale: 1,
    still: 30,
    natural: [hex('#ff9a5c'), hex('#5a4a9a')],
    frag: LANDSCAPE,
  },
  water: {
    id: 'water',
    labelKey: 'set.background.water',
    fps: 30,
    scale: 0.9,
    still: 12,
    // Sunlight through the waves: a pale aqua for the light, a clear deep
    // blue for the water itself.
    natural: [hex('#8fe6ff'), hex('#0b5bbf')],
    frag: WATER,
  },
};

/** The drawn backgrounds, in the picker's order. */
export const DRAWN_EFFECTS = BACKGROUND_EFFECTS.filter((e): e is DrawnEffect => e !== 'none');

export const isDrawn = (e: BackgroundEffect | undefined | null): e is DrawnEffect =>
  !!e && e !== 'none';
