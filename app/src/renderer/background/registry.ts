import { BACKGROUND_EFFECTS, type BackgroundEffect } from '@shared/backgrounds';
import type { MessageKey } from '@shared/i18n';
import type { Rgb } from './palette';
import {
  AURORA,
  ELECTRICITY,
  FIRE,
  LANDSCAPE,
  LAVA,
  NEBULA,
  RAIN,
  SMOKE,
  WATER,
} from './shaders/effects';

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
  /** Its own colours, for when "Use palette colours" is off: [main, second],
   *  for a dark page and for a light one. */
  natural: { dark: [Rgb, Rgb]; light: [Rgb, Rgb] };
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
    natural: { dark: [hex('#a9b8c8'), hex('#64707e')], light: [hex('#4e5864'), hex('#7d8894')] },
    frag: SMOKE,
  },
  fire: {
    id: 'fire',
    labelKey: 'set.background.fire',
    fps: 30,
    scale: 1,
    still: 21,
    natural: { dark: [hex('#ff8a2a'), hex('#c0250c')], light: [hex('#d9480f'), hex('#a61e0a')] },
    frag: FIRE,
  },
  electricity: {
    id: 'electricity',
    labelKey: 'set.background.electricity',
    fps: 30,
    scale: 1,
    still: 1.55,
    natural: { dark: [hex('#8fb8ff'), hex('#7a5cff')], light: [hex('#1f5fd1'), hex('#6a3fd1')] },
    frag: ELECTRICITY,
  },
  lava: {
    id: 'lava',
    labelKey: 'set.background.lava',
    fps: 24,
    scale: 0.9,
    still: 80,
    natural: { dark: [hex('#ff6a10'), hex('#b8160a')], light: [hex('#d24a0c'), hex('#8e1408')] },
    frag: LAVA,
  },
  aurora: {
    id: 'aurora',
    labelKey: 'set.background.aurora',
    fps: 30,
    scale: 0.75,
    still: 18,
    natural: { dark: [hex('#38f08f'), hex('#8a5cff')], light: [hex('#0f9d5c'), hex('#6a3fd1')] },
    frag: AURORA,
  },
  nebula: {
    id: 'nebula',
    labelKey: 'set.background.nebula',
    fps: 24,
    scale: 0.9,
    still: 40,
    natural: { dark: [hex('#e05ac0'), hex('#3d6bff')], light: [hex('#b02a8f'), hex('#2448c9')] },
    frag: NEBULA,
  },
  landscape: {
    id: 'landscape',
    labelKey: 'set.background.landscape',
    fps: 12,
    scale: 1,
    still: 30,
    natural: { dark: [hex('#ff9a5c'), hex('#5a4a9a')], light: [hex('#f2a65a'), hex('#6b8fc4')] },
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
    natural: { dark: [hex('#8fe6ff'), hex('#0b5bbf')], light: [hex('#0d7fb5'), hex('#0b4f9e')] },
    frag: WATER,
  },
  rain: {
    id: 'rain',
    labelKey: 'set.background.rain',
    fps: 30,
    scale: 1,
    still: 20,
    // A city at night through wet glass: sodium-amber street lights and a cool
    // white-blue. The shader adds the odd red tail light and warm white of its
    // own, palette off (`uPal`).
    natural: { dark: [hex('#ffb35c'), hex('#7fb2ff')], light: [hex('#c66a12'), hex('#2f66c9')] },
    frag: RAIN,
  },
};

/** The drawn backgrounds, in the picker's order. */
export const DRAWN_EFFECTS = BACKGROUND_EFFECTS.filter((e): e is DrawnEffect => e !== 'none');

export const isDrawn = (e: BackgroundEffect | undefined | null): e is DrawnEffect =>
  !!e && e !== 'none';
