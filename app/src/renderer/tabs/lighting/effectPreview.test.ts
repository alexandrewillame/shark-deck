import { describe, expect, it } from 'vitest';
import { KB_LIGHT_EFFECTS_TABLE } from '@shared/lighting';
import { effectColor, isStaticEffect, previewRgbCss, type PreviewParams } from './effectPreview';

/**
 * The effect previews are illustrations, not simulations, so there is no
 * "correct" frame to assert against. What IS worth pinning is that every
 * listed effect has its own animation and that the colour controls reach it —
 * the two things that were actually wrong: 20+ effects shared eight generic
 * renderers, and the rainbow/colour flag reached only the static branch.
 */
const params = (over: Partial<PreviewParams> = {}): PreviewParams => ({
  phase: 0.3,
  bounds: { maxX: 5, maxY: 2 },
  color: [255, 0, 0],
  brightness: 100,
  rainbow: false,
  ...over,
});

/** Sample a whole board at several phases — one key at one instant says very
 *  little about an animation. */
const frames = (label: string, p: Partial<PreviewParams> = {}): string[] => {
  const out: string[] = [];
  for (const phase of [0, 0.17, 0.34, 0.51, 0.68, 0.85]) {
    for (let x = 0; x <= 5; x++) {
      for (let y = 0; y <= 2; y++) out.push(effectColor(label, { x, y }, params({ ...p, phase })));
    }
  }
  return out;
};

const LISTED = KB_LIGHT_EFFECTS_TABLE.filter((e) => e.listed);

/**
 * Effects that paint the WHOLE board one colour at a time on purpose, so
 * "more than one hue at once" is the wrong thing to ask of them.
 *
 * Breath is the board inhaling in one colour, going fully dark, and coming
 * back in another — a spatial gradient would make it a different effect. It
 * still cycles through the spectrum, just over time rather than over space.
 */
const WHOLE_BOARD_IDS = new Set(['LightBreath']);

/** The shared "key is off" colour — see `dark()` in effectPreview.ts. */
const DARK = 'rgb(10, 10, 12)';

/** The strongest RGB channel of a CSS colour, 0..255 — `rgb()` or `hsl()`. */
const peakChannel = (css: string): number => {
  const rgb = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(css);
  if (rgb) return Math.max(...rgb.slice(1).map(Number));
  const hsl = /^hsl\(-?[\d.]+, ([\d.]+)%, ([\d.]+)%\)$/.exec(css);
  if (!hsl) throw new Error(`not a colour: ${css}`);
  // The brightest channel of an HSL colour is L + C/2, with chroma
  // C = (1 - |2L - 1|) * S. The hue only decides WHICH channel that is.
  const s = Number(hsl[1]) / 100;
  const l = Number(hsl[2]) / 100;
  return 255 * (l + ((1 - Math.abs(2 * l - 1)) * s) / 2);
};

/** Lit as `litCap` means it: a key below 5% drive is drawn as an unlit cap. */
const isLit = (css: string): boolean => peakChannel(css) >= 255 * 0.05;

/** The hue of an `hsl()` colour, in degrees. */
const hueOf = (css: string): number => Number(/^hsl\((-?[\d.]+)/.exec(css)?.[1] ?? NaN);

describe('effect previews', () => {
  it('every listed effect renders a colour for every key', () => {
    for (const e of LISTED) {
      for (const c of frames(e.label)) {
        expect(c, `${e.label} produced ${c}`).toMatch(/^(rgb|hsl)\(/);
      }
    }
  });

  it('every animated effect actually changes over a cycle', () => {
    for (const e of LISTED) {
      if (isStaticEffect(e.label)) continue;
      const set = new Set(frames(e.label));
      expect(set.size, `${e.label} is listed as animated but never changes`).toBeGreaterThan(1);
    }
  });

  it('a static effect does not change over a cycle', () => {
    // "Always On" is the default the tab lands on. If it animated, the board
    // preview would contradict the "shows colour and brightness only" hint.
    expect(new Set(frames('Always On')).size).toBe(1);
  });

  it('uses the chosen colour, and only the chosen colour, when not in rainbow mode', () => {
    // The bug this pins: wave/spectrum ignored `color` entirely, so picking
    // red previewed as a rainbow sweep.
    for (const e of LISTED) {
      if (!e.colour) continue; // effects that carry no colour of their own
      const seen = frames(e.label, { color: [255, 0, 0], rainbow: false });
      const hues = seen.filter((c) => c.startsWith('hsl('));
      expect(hues, `${e.label} fell back to hues despite a chosen colour`).toHaveLength(0);
      // Red only: green and blue stay at zero whatever the intensity. The
      // one exception is the shared "this key is off" value, which is a
      // deliberate neutral near-black so a dark key reads as dark rather than
      // as a hole in the board.
      for (const c of seen) {
        if (c === DARK) continue;
        const m = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(c);
        if (!m) continue;
        expect(Number(m[2]), `${e.label} leaked green`).toBe(0);
        expect(Number(m[3]), `${e.label} leaked blue`).toBe(0);
      }
    }
  });

  it('goes multicolour in rainbow mode', () => {
    // And the other direction: with dazzle on, a breathing effect used to
    // preview in the single colour because the flag never reached that branch.
    for (const e of LISTED) {
      if (!e.dazzle || isStaticEffect(e.label)) continue;
      const seen = frames(e.label, { rainbow: true });
      expect(
        seen.some((c) => c.startsWith('hsl(')),
        `${e.label} stayed single-coloured in rainbow mode`,
      ).toBe(true);
    }
  });

  it('shows more than one hue AT ONCE in rainbow mode', () => {
    // The check above is satisfied by a board painted one flat hue, which is
    // what half of these actually did: `tint`'s rainbow branch takes its hue
    // entirely from the caller's `hueOffset`, and Always On, Breath, Press
    // Action, Press Action Off and Press Laser all passed the constant 0.5.
    // "Rainbow" therefore previewed as a single cyan.
    //
    // Per FRAME, not across frames — an effect that cycles the whole board
    // through the spectrum together is still unicolour at any instant.
    for (const e of LISTED) {
      if (!e.dazzle || WHOLE_BOARD_IDS.has(e.id)) continue;
      const best = [0, 0.17, 0.34, 0.51, 0.68, 0.85].map((phase) => {
        const hues = new Set<string>();
        for (let x = 0; x <= 5; x++) {
          for (let y = 0; y <= 2; y++) {
            const c = effectColor(e.label, { x, y }, params({ phase, rainbow: true }));
            const m = /^hsl\((-?[\d.]+)/.exec(c);
            // Rounded: two keys a hundredth of a degree apart are the same
            // colour to a human and must not count as variety.
            if (m) hues.add(String(Math.round(Number(m[1]) / 10)));
          }
        }
        return hues.size;
      });
      expect(
        Math.max(...best),
        `${e.label} paints the whole board one hue in rainbow mode`,
      ).toBeGreaterThan(1);
    }
  });

  it('respects brightness', () => {
    const bright = frames('Breath', { brightness: 100 });
    const dim = frames('Breath', { brightness: 0 });
    expect(bright).not.toEqual(dim);
  });

  it('draws the board OFF at brightness 0, in either colour mode', () => {
    // Two floors kept it lit: `previewLevel` bottomed out at 12%, and every
    // rainbow branch added a constant to its lightness. Brightness 0 turns the
    // real keyboard dark, and `litCap` draws anything under 5% drive as an
    // unlit cap — so that is the bar: nothing above it, on any key, at any
    // phase, whichever way the effect makes its colour.
    for (const label of ['Always On', 'Breath', 'Wave', 'Spectrum Cycle'])
      for (const rainbow of [false, true])
        for (const c of frames(label, { brightness: 0, rainbow }))
          expect(isLit(c), `${label} (rainbow=${rainbow}) drew ${c} at brightness 0`).toBe(false);
  });
});

/**
 * The direction control.
 *
 * Reported as "I pick Right and your animation goes left", and it was two
 * defects in one place: the option never reached the preview at all (every
 * choice drew the same sweep), and the rainbow branch of Wave travelled the
 * opposite way to its own single-colour branch, so the answer depended on
 * whether dazzle happened to be on.
 */
describe('direction options', () => {
  /** How far along the axis the board's one bright band sits, 0..1. */
  const peak = (label: string, axis: 'x' | 'y', p: Partial<PreviewParams>): number => {
    const N = 60;
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < N; i++) {
      const k = axis === 'x' ? { x: i, y: 0 } : { x: 0, y: i };
      const c = effectColor(
        label,
        k,
        params({
          ...p,
          bounds: axis === 'x' ? { maxX: N - 1, maxY: 0 } : { maxX: 0, maxY: N - 1 },
        }),
      );
      // In rainbow mode every key is equally bright and the HUE is what
      // travels, so the feature to track is "where is this hue right now".
      // With a colour chosen it is brightness. One score covers both: how
      // close this key is to a fixed reference.
      const hsl = /^hsl\((-?[\d.]+)/.exec(c);
      const score = hsl
        ? -Math.abs((((Number(hsl[1]) - 200) % 360) + 540) % 360) + 180
        : Math.max(...(/(\d+), (\d+), (\d+)/.exec(c) ?? ['', '0', '0', '0']).slice(1).map(Number));
      if (score > bestScore) {
        bestScore = score;
        best = i / (N - 1);
      }
    }
    return best;
  };

  /** +1 if the band travels toward the far end of the axis, -1 if back. */
  const travel = (label: string, axis: 'x' | 'y', p: Partial<PreviewParams>): number => {
    let sum = 0;
    for (const phase of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]) {
      const a = peak(label, axis, { ...p, phase });
      const b = peak(label, axis, { ...p, phase: phase + 0.02 });
      // Shortest way round: a band leaving one edge reappears at the other.
      let d = b - a;
      if (d > 0.5) d -= 1;
      if (d < -0.5) d += 1;
      sum += d;
    }
    return Math.sign(sum);
  };

  // Wave's own list, in wire order.
  const WAVE = [
    { option: 0, axis: 'x' as const, want: 1 }, // Right
    { option: 1, axis: 'x' as const, want: -1 }, // Left
    { option: 2, axis: 'y' as const, want: 1 }, // Down
    { option: 3, axis: 'y' as const, want: -1 }, // Up
  ];

  it('sends Wave the way the label says, in either colour mode', () => {
    for (const { option, axis, want } of WAVE) {
      for (const rainbow of [false, true]) {
        expect(
          travel('Wave', axis, { option, rainbow }),
          `Wave option ${option} (${axis}) went the wrong way with rainbow=${rainbow}`,
        ).toBe(want);
      }
    }
  });

  it('sends Line Wave right on 0 and left on 1', () => {
    expect(travel('Line Wave', 'x', { option: 0 })).toBe(1);
    expect(travel('Line Wave', 'x', { option: 1 })).toBe(-1);
  });

  it('slides the Always On layout sideways for Line Wave in rainbow mode', () => {
    // In rainbow mode the board shows Always On's diagonal bands moving
    // across it, not a brightness front with a hue per row. So at phase 0 the
    // two are the same picture, for either direction...
    for (const option of [0, 1])
      for (const k of [
        { x: 0, y: 0 },
        { x: 3, y: 1 },
        { x: 5, y: 2 },
      ])
        expect(effectColor('Line Wave', k, params({ rainbow: true, phase: 0, option }))).toBe(
          effectColor('Always On', k, params({ rainbow: true, phase: 0 })),
        );
    // ...and then the bands go the way the label says.
    expect(travel('Line Wave', 'x', { option: 0, rainbow: true })).toBe(1);
    expect(travel('Line Wave', 'x', { option: 1, rainbow: true })).toBe(-1);
  });

  /**
   * A board with an odd number of columns and rows.
   *
   * The 6x3 board `frames` uses cannot tell Wave's Down from its Up: a wave of
   * period 1 sampled at exactly {0, 0.5, 1} has the same value at both ends,
   * so reversing the axis maps the samples onto themselves. That is an
   * artefact of three rows, not of the effect.
   */
  const bigFrames = (label: string, p: Partial<PreviewParams> = {}): string[] => {
    const bounds = { maxX: 8, maxY: 4 };
    const out: string[] = [];
    for (const phase of [0, 0.17, 0.34, 0.51, 0.68, 0.85])
      for (let x = 0; x <= bounds.maxX; x++)
        for (let y = 0; y <= bounds.maxY; y++)
          out.push(effectColor(label, { x, y }, params({ ...p, bounds, phase })));
    return out;
  };

  it('draws something different for every option an effect offers', () => {
    // The whole class of bug: the control existed, the driver honoured it, and
    // the preview ignored it — so the only way to find out what an option did
    // was to write it to the keyboard.
    for (const e of LISTED) {
      if (!e.options || e.id === 'LightUserPicture') continue; // patterns are per-key data
      const seen = e.options.map((_, option) => bigFrames(e.label, { option }).join('|'));
      expect(new Set(seen).size, `${e.label} draws the same thing for every option`).toBe(
        e.options.length,
      );
    }
  });

  it('ignores an option an effect does not have', () => {
    // `option` is one nibble shared by every effect and it survives a switch
    // between them, so a renderer can be handed an index off the end of its
    // own list. That must fall back, not render blank.
    expect(frames('Breath', { option: 7 })).toEqual(frames('Breath', { option: 0 }));
  });
});

describe('Always On in rainbow mode', () => {
  // The real board's proportions, in key units: the R85HE is 15.13 wide by
  // 5.22 tall, and the shape of the bands only goes wrong on a board that is
  // not square.
  const board = { maxX: 15.13, maxY: 5.22 };
  const hueAt = (x: number, y: number): number =>
    hueOf(effectColor('Always On', { x, y }, params({ rainbow: true, bounds: board })));
  const STEPS = Array.from({ length: 21 }, (_, i) => i / 20);

  it('gives keys with the same x - y the same hue: bands at a true 45 degrees', () => {
    // `(nx + ny) / 2` normalised each axis before adding them, so on this
    // board a band of one hue rose to the right at about 19 degrees. In key
    // units one step right and one step down is the same band — the "\"
    // diagonal, top-left to bottom-right.
    for (const [x, y] of [
      [0, 0.02],
      [2, 1.22],
      [7.5, 3.22],
      [12.1, 0.02],
    ] as const)
      expect(hueAt(x + 2, y + 2), `from (${x}, ${y})`).toBeCloseTo(hueAt(x, y), 6);
  });

  it('steps the hue one way along the diagonal, the whole spectrum once per board', () => {
    const climbing = (keys: (readonly [number, number])[]): number[] => {
      const hues = keys.map(([x, y]) => hueAt(x, y));
      for (let i = 1; i < hues.length; i++)
        expect(hues[i]!, `step ${i} of ${hues.join(', ')}`).toBeGreaterThan(hues[i - 1]!);
      return hues;
    };
    // From the top-left corner key to the bottom-right one...
    climbing(STEPS.map((t) => [t * board.maxX, t * board.maxY] as const));
    // ...and across the bands, bottom-left to top-right: red at one corner,
    // round the whole wheel by the other, no band repeated in between.
    const across = climbing(
      STEPS.filter((t) => t < 1).map((t) => [t * board.maxX, (1 - t) * board.maxY] as const),
    );
    expect(across[0]).toBeCloseTo(0, 6);
    expect(across[across.length - 1]!).toBeGreaterThan(330);
  });
});

describe('Snake', () => {
  // The 6x3 tile: three rows, a third of the cycle each.
  const tile = (phase: number): { x: number; y: number; c: string }[] => {
    const out: { x: number; y: number; c: string }[] = [];
    for (let x = 0; x <= 5; x++)
      for (let y = 0; y <= 2; y++)
        out.push({ x, y, c: effectColor('Snake', { x, y }, params({ phase, option: 0 })) });
    return out;
  };
  /** The rows holding a lit key at this phase. */
  const litRows = (phase: number): number[] => [
    ...new Set(
      tile(phase)
        .filter((k) => isLit(k.c))
        .map((k) => k.y),
    ),
  ];
  /** The column of the brightest key at this phase: where the head is. */
  const headX = (phase: number): number =>
    tile(phase).reduce((best, k) => (peakChannel(k.c) > peakChannel(best.c) ? k : best)).x;

  it('is one segment: never more than one row lit, and every row in its turn', () => {
    // Every row used to carry its own band, all sliding at once — six lines
    // on the real board, which is a wave with gaps, not a snake.
    const seen = new Set<number>();
    for (let i = 0; i < 90; i++) {
      const rows = litRows(i / 90);
      expect(rows.length, `phase ${i / 90} lit rows ${rows.join(', ')}`).toBeLessThanOrEqual(1);
      for (const r of rows) seen.add(r);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
  });

  it('comes back the other way on the next row', () => {
    // Right along the top row, left along the middle, right again along the
    // bottom: the path is a boustrophedon, which is what "zigzag" means here.
    expect(headX(0.25)).toBeGreaterThan(headX(0.1));
    expect(headX(0.6)).toBeLessThan(headX(0.4));
    expect(headX(0.9)).toBeGreaterThan(headX(0.75));
  });
});

describe('Press Action Off', () => {
  it('holds exactly what Always On paints, until a key is struck', () => {
    // Its whole description is "Always On, and the key you hit goes out for a
    // moment". The resting board used to DRIFT through the spectrum in
    // rainbow mode, which is a second animation the effect does not have.
    const p = params({ rainbow: true, phase: 0.42 });
    // A corner far from the simulated press, so only the resting state shows.
    const at = { x: 0, y: 0 };
    expect(effectColor('Press Action Off', at, p)).toBe(effectColor('Always On', at, p));
  });
});

/**
 * The side strip is one long diffused bar, not a short keyboard, and it was
 * drawn with the board's own renderers because the two share effect names.
 * Two of them are simply different objects on a bar.
 */
describe('the side strip', () => {
  /** Sample along the bar. */
  const bar = (label: string, p: Partial<PreviewParams> = {}, n = 48): string[] => {
    const bounds = { maxX: n - 1, maxY: 0 };
    return Array.from({ length: n }, (_, i) =>
      effectColor(label, { x: i, y: 0 }, params({ ...p, bounds, strip: true })),
    );
  };
  /** How many times the hue wraps the wheel from one end to the other. */
  const hueWraps = (out: string[]): number => {
    const hues = out.map((c) => Number(/^hsl\((-?[\d.]+)/.exec(c)?.[1] ?? NaN));
    let wraps = 0;
    for (let i = 1; i < hues.length; i++) if (hues[i]! < hues[i - 1]!) wraps++;
    return wraps;
  };

  it('repeats the spectrum several times along Always On, not once', () => {
    // Counted off the hardware: the bar holds about six full cycles. Sharing
    // the board's renderer drew ONE gradient end to end.
    expect(hueWraps(bar('Always On', { rainbow: true }))).toBeGreaterThanOrEqual(5);
  });

  it('keeps Always On one flat colour when a colour is chosen', () => {
    // There is nothing to repeat: "always on" in one colour is that colour.
    expect(new Set(bar('Always On', { rainbow: false })).size).toBe(1);
  });

  it('makes Snake one travelling point, with the bar dark around it', () => {
    // It used to slide whole rows, which on a bar meant the whole bar was lit
    // the whole time — the reported "you show it always lit".
    const out = bar('Snake', { phase: 0.5 });
    const litCells = out.filter((c) => c !== 'rgb(10, 10, 12)').length;
    expect(litCells).toBeGreaterThan(0);
    expect(litCells / out.length).toBeLessThan(0.35);
  });

  it('moves that point along the bar', () => {
    const at = (phase: number) => {
      const out = bar('Snake', { phase });
      let best = 0;
      let bestV = -1;
      out.forEach((c, i) => {
        const v = Math.max(
          ...(/(\d+), (\d+), (\d+)/.exec(c) ?? ['', '0', '0', '0']).slice(1).map(Number),
        );
        if (v > bestV) [bestV, best] = [v, i];
      });
      return best;
    };
    expect(at(0.6)).toBeGreaterThan(at(0.3));
  });

  it('leaves every other effect to the board renderer', () => {
    // Only the two that genuinely differ are overridden; a second near-copy of
    // Breath or Spectrum Cycle would be two places to fix one thing.
    for (const label of ['Breath', 'Spectrum Cycle', 'Wave'])
      expect(bar(label)).toEqual(
        Array.from({ length: 48 }, (_, i) =>
          effectColor(
            label,
            { x: i, y: 0 },
            params({ bounds: { maxX: 47, maxY: 0 }, strip: false }),
          ),
        ),
      );
  });
});

describe('per-key preview brightness', () => {
  // The per-key board used to ignore the brightness slider entirely, while the
  // Global preview dimmed with it. Both now go through one rule.
  it('leaves a colour as it is at full brightness, and dims it the way an eye sees', () => {
    expect(previewRgbCss([255, 255, 255], 100)).toBe('rgb(255, 255, 255)');
    // Half duty is not half as bright to an eye: about 73%.
    expect(previewRgbCss([200, 100, 0], 50)).toBe('rgb(146, 73, 0)');
  });

  it('shows every colour plainly at the lowest real level', () => {
    // Reported: at brightness 1 of 4 the board looked switched off, while
    // the keyboard itself showed every colour clearly — so "Read from
    // keyboard" looked broken. Level 1 now draws at about half of full.
    const [r] = /\d+/.exec(previewRgbCss([255, 0, 0], 25))!.map(Number);
    expect(r).toBeGreaterThan(125);
    // ...and the levels still step up, so the slider still means something.
    const at = (b: number) => Number(/\d+/.exec(previewRgbCss([255, 0, 0], b))![0]);
    expect(at(25)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(75));
    expect(at(75)).toBeLessThan(at(100));
  });

  it('keeps painted keys visible at 0, where the Global preview goes dark', () => {
    // The per-key pane is an editor: a painted key has to stay visible to be
    // selected and repainted even at a brightness that turns the board off.
    // This floor is the one place the two panes part.
    expect(previewRgbCss([255, 0, 0], 0)).toBe('rgb(31, 0, 0)');
  });

  it('draws a colour exactly as the Global pane draws Always On in it', () => {
    // At every real level, 1-4. Not at 0: there the board is switched off
    // while the paint keeps its floor, by design (see above).
    const k = { x: 3, y: 2 };
    for (const brightness of [25, 50, 75, 100]) {
      const g = effectColor('Always On', k, {
        phase: 0,
        bounds: { maxX: 10, maxY: 5 },
        color: [61, 248, 232],
        brightness,
        rainbow: false,
      });
      expect(previewRgbCss([61, 248, 232], brightness), `at ${brightness}`).toBe(g);
    }
  });
});
