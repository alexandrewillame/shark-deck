import { describe, expect, it } from 'vitest';
import {
  COLOR_PRESET_ROWS,
  LED_WHITE,
  SWATCH_HUES,
  emittedRgb,
  hexToRgb,
  hsvToRgb,
  litCap,
  rgbToHsv,
} from './colorUtil';
import { GROUP_HUES } from './tabs/keyboard/useKeyGroups';
import { deltaEHex } from '../../test/lib/colorDistance';

/** `rgb(r, g, b)` -> `#rrggbb`, for the distance helper. */
const hex = (rgb: string) =>
  '#' +
  /(\d+), (\d+), (\d+)/
    .exec(rgb)!
    .slice(1)
    .map((n) => Number(n).toString(16).padStart(2, '0'))
    .join('');

/**
 * `litCap` decides what a backlit keycap looks like, and it inherits the one
 * bug `readableTextOn` exists to prevent: paint a key white, read the label
 * colour off the wrong surface, get white on white.
 *
 * The trap here is subtler than the original. The cap is no longer the LED
 * colour, so anything measuring the LED is measuring the wrong thing — and a
 * white LED produces a *light* cap while a dim one produces a nearly black
 * cap, so the two ends of the range want opposite label colours. Both ends
 * are pinned below.
 */
describe('litCap', () => {
  const alpha = (rgba: string) => Number(/,\s*([\d.]+)\)$/.exec(rgba)![1]);
  const chan = (rgb: string) => /(\d+), (\d+), (\d+)/.exec(rgb)!.slice(1).map(Number);

  it('declines a colour it cannot measure, like readableTextOn does', () => {
    expect(litCap('var(--accent)')).toBeNull();
    expect(litCap('linear-gradient(90deg, red, blue)')).toBeNull();
  });

  it("lights the face in the diode's colour, so every colour reads as itself", () => {
    // Reported, again and again: "white is depicted as yellow — put a yellow
    // key next to a white one and they are too similar". The face was grey
    // plastic taking a third of the colour, and a grey plus a little yellow is
    // olive, plus a little white is grey. A colour only reads as itself when
    // it is bright, so the face carries it.
    const [r, g, b] = chan(litCap('#ff0000')!.cap);
    expect(r).toBeGreaterThan(200);
    expect(Math.max(g!, b!)).toBeLessThan(40);
    const yellow = chan(litCap('#ffdd00')!.cap);
    expect(yellow[0]!).toBeGreaterThan(200);
    expect(yellow[1]!).toBeGreaterThan(170);
    expect(yellow[2]!).toBeLessThan(40);
  });

  it('keeps white and yellow far apart, at full brightness and at the lowest level', () => {
    // previewRgbCss at brightness 25 hands litCap the colour at 53%.
    const at = (c: string, f: number) =>
      `rgb(${chan(c)
        .map((n) => Math.round(n * f))
        .join(', ')})`;
    for (const f of [1, 0.53]) {
      const white = litCap(at('rgb(255, 255, 255)', f))!.cap;
      const yellow = litCap(at('rgb(255, 221, 0)', f))!.cap;
      expect(deltaEHex(hex(white), hex(yellow)), `at ${f}`).toBeGreaterThan(50);
      // ...and white stays white: light, and never warm.
      const w = chan(white);
      expect(Math.min(...w), `at ${f}`).toBeGreaterThan(170);
      expect(w[2]!).toBeGreaterThanOrEqual(w[0]!);
    }
  });

  it('dims the edge and the pool much more than the face', () => {
    const dim = litCap('#400000')!;
    const full = litCap('#ff0000')!;
    // The parts that carry the light scale hard with drive…
    expect(alpha(full.rim) / alpha(dim.rim)).toBeGreaterThan(3);
    expect(alpha(full.glow) / alpha(dim.glow)).toBeGreaterThan(2);
    // …while the face stays plainly the colour, as a real board's keys do even
    // at its lowest level.
    expect(chan(full.cap)[0]! / chan(dim.cap)[0]!).toBeLessThan(2);
  });

  it('prints the legend dark on a light face and light on a dark one', () => {
    const contrast = (a: string, b: string) => {
      const lum = (c: string) => {
        const [r, g, b2] = chan(c).map((n) => {
          const x = n / 255;
          return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b2!;
      };
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    for (const c of ['#ffffff', '#ffdd00', '#00ff00', '#0000ff', '#ff0000', '#8800ff']) {
      const cap = litCap(c)!;
      // An rgba legend is drawn at 78% black over the face: near enough black.
      const legend = cap.legend.startsWith('rgba') ? 'rgb(0, 0, 0)' : cap.legend;
      expect(contrast(cap.cap, legend), c).toBeGreaterThan(3);
    }
    expect(litCap('#ffffff')!.legendShadow).toBe('none');
    expect(litCap('#0000ff')!.legendShadow).not.toBe('none');
  });

  it('drives the glow from how hard the diode runs, not from luminance', () => {
    // Saturated blue has a Rec. 709 luminance of 0.07 and is plainly ON. If
    // the glow were scaled by luminance every blue key would look unlit, so
    // full-power blue and full-power white must glow equally hard.
    expect(alpha(litCap('#0000ff')!.glow)).toBeCloseTo(alpha(litCap('#ffffff')!.glow), 5);
  });

  it('leaves an unlit key as a keycap, not a hole in the board', () => {
    // An effect's dark keys (`rgb(10, 10, 12)`) and the per-key editor's black
    // are OFF: an unlit cap, no edge, no pool.
    for (const c of ['rgb(10,10,12)', 'rgb(0, 0, 0)']) {
      const off = litCap(c)!;
      expect(alpha(off.glow)).toBe(0);
      expect(alpha(off.rim)).toBe(0);
      expect(off.cap).toBe('rgb(48, 48, 48)');
    }
  });

  it('gives ONE answer per LED, not one per UI theme', () => {
    // Reported: white read as white in light mode and as a yellow-grey in
    // dark, and blue was a different blue in each. `litCap` used to return a
    // second colour set for a "lit room" that the stylesheet picked off
    // `:root[data-mode]` — so flipping the app's theme changed the colour of
    // a diode. Nothing here may be per-theme again.
    expect(Object.keys(litCap('#ff0000')!).sort()).toEqual([
      'cap',
      'glow',
      'led',
      'legend',
      'legendShadow',
      'rim',
    ]);
  });

  it('keeps the LED colour where the LED put it', () => {
    // The cap used to be a blue that every colour was mixed toward: white
    // came out a muddy blue-grey. The unlit cap is a true grey now, and white
    // lights it in the diode's own cool white (`LED_WHITE`) — light, never
    // blue, never warm.
    const white = chan(litCap('#ffffff')!.cap);
    expect(Math.max(...white) - Math.min(...white)).toBeLessThan(20);
    expect(white[2]!).toBeGreaterThanOrEqual(white[0]!);
    // Blue stays far and away the leading channel — it is a blue cap, not a
    // teal one. (Green sits between the two because of `emittedRgb`; see the
    // next block.)
    const blue = chan(litCap('#0000ff')!.cap);
    expect(blue[2]!).toBeGreaterThan(blue[0]! + 60);
    expect(blue[2]!).toBeGreaterThan(blue[1]! + 45);
  });

  it('hands back the original colour untouched, for the bare-board fill', () => {
    // A thumbnail is a diagram of a preset, not a photograph: there the key IS
    // the colour (see .kbmap-bare in keyboard-map.css).
    expect(litCap('rgb(1,2,3)')!.led).toBe('rgb(1,2,3)');
  });
});

/**
 * The picker drives its square from HSV and writes back RGB, so any loss in
 * the round trip shows up as the handle drifting while you drag it.
 */
describe('rgbToHsv / hsvToRgb', () => {
  it('round-trips every preset exactly', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#3df8e8', '#ffb454', '#ffffff', '#000000'])
      expect(hsvToRgb(...rgbToHsv(hexToRgb(hex)))).toEqual(hexToRgb(hex));
  });

  it('round-trips arbitrary colours to within a rounding step', () => {
    for (const rgb of [
      [17, 200, 99],
      [5, 5, 6],
      [250, 3, 128],
      [128, 128, 128],
    ] as Array<[number, number, number]>) {
      const back = hsvToRgb(...rgbToHsv(rgb));
      for (const i of [0, 1, 2]) expect(Math.abs(back[i]! - rgb[i]!)).toBeLessThanOrEqual(1);
    }
  });

  it('reports no hue for greys rather than an arbitrary one', () => {
    // Saturation 0 is what tells the picker not to move its hue strip; a
    // non-zero hue on a grey would snap the strip every time the square was
    // dragged into a corner.
    for (const g of [
      [0, 0, 0],
      [128, 128, 128],
      [255, 255, 255],
    ] as Array<[number, number, number]>)
      expect(rgbToHsv(g)[1]).toBe(0);
  });
});

/**
 * There are two swatch grids in the app — key groups on the Actuation tab and
 * LED presets on Lighting — and they used to share nothing: eight hues at
 * three depths there, seven hand-picked colours here. "Give me that colour"
 * therefore meant a different colour depending on which tab you were on.
 */
describe('the preset grid', () => {
  it('offers every shared hue, at every level', () => {
    for (const row of COLOR_PRESET_ROWS) {
      // One column per hue, plus the neutral that belongs to none of them.
      expect(row).toHaveLength(SWATCH_HUES.length + 1);
    }
    expect(new Set(COLOR_PRESET_ROWS.flat()).size).toBe(COLOR_PRESET_ROWS.flat().length);
  });

  it('is the same hues the key-group picker offers, in the same order', () => {
    // The two grids are built from one list; this is what says so. (The group
    // picker adds a slate after them, where this grid has its neutral column.)
    expect(GROUP_HUES.slice(0, SWATCH_HUES.length)).toEqual(SWATCH_HUES.map((h) => h.name));
  });

  it('gives the hue row pure, saturated colours — these drive a diode', () => {
    // Where the grids part company. A group swatch is ink in the app and can
    // be `l: 36`; the same value written to an LED is a dim red rather than
    // "red", so the top row runs each hue flat out.
    for (const hex of COLOR_PRESET_ROWS[0]!.slice(0, SWATCH_HUES.length)) {
      const [, s, v] = rgbToHsv(hexToRgb(hex));
      expect(s).toBeCloseTo(1, 2);
      expect(v).toBeCloseTo(1, 2);
    }
  });

  it('keeps black reachable, which is the only per-key off switch', () => {
    expect(COLOR_PRESET_ROWS.flat()).toContain('#000000');
    expect(COLOR_PRESET_ROWS.flat()).toContain('#ffffff');
  });

  it('keeps orange and the pink far enough from red to stay themselves', () => {
    // The reported case: an orange at 30° and a pink at 325° beside the red
    // column. A diode's red channel dominates, so on the keyboard both read as
    // more red. They are in the grid — a picker without them is a poor one —
    // just where they hold up: orange at 35°, the pink a magenta at 318°.
    const off = (h: number) => Math.min(h, 360 - h);
    for (const c of SWATCH_HUES) {
      if (c.name === 'red') continue;
      expect(off(c.h), `${c.name} at ${c.h}`).toBeGreaterThanOrEqual(35);
    }
  });

  it('keeps every pair of LED swatches in a row apart', () => {
    // Measured, not eyeballed: the LED rows mix hues with white or run them
    // down, which is where neighbouring hues converge.
    for (const row of COLOR_PRESET_ROWS) {
      for (let i = 0; i < row.length; i++) {
        for (let j = i + 1; j < row.length; j++) {
          const d = deltaEHex(row[i]!, row[j]!);
          // The closest pair is 22.2 (soft yellow/lime).
          expect(d, `${row[i]} vs ${row[j]} is only ${d.toFixed(1)}`).toBeGreaterThan(20);
        }
      }
    }
  });
});

/**
 * "Blue seems purple."
 *
 * Not a bug in the LED model — sRGB's blue primary really does look violet;
 * its dominant wavelength is about 464nm. But a photograph of a blue-backlit
 * keyboard is azure, because light through a translucent cap is not
 * monochromatic any more. This is the one correction in colorUtil that moves
 * a hue, so it is worth being exact about which colours it may touch.
 */
describe('emittedRgb', () => {
  it('turns the blue primary into a blue you would recognise', () => {
    const [r, g, b] = emittedRgb([0, 0, 255]);
    expect([r, b]).toEqual([0, 255]); // only green moves
    expect(g).toBeGreaterThan(60); // and it moves enough to read as azure
  });

  it('leaves every saturated colour that is not blue-dominant exactly alone', () => {
    for (const c of [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 255, 255],
      [255, 180, 0],
      [200, 0, 200],
    ] as Array<[number, number, number]>)
      expect(emittedRgb(c)).toEqual(c);
  });

  it("draws white as the diode's cool white, not as a neutral that reads yellow", () => {
    // Reported three times: "white still looks yellow". Every layer of a white
    // key was byte-neutral, and a neutral sitting in an app whose surfaces and
    // text are all faintly blue reads warm. Three dies at full make a cool
    // white, and that is what is drawn.
    const [r, g, b] = emittedRgb([255, 255, 255]);
    expect([r, g, b]).toEqual([...LED_WHITE]);
    expect(b).toBe(255);
    expect(b).toBeGreaterThan(r);
    // Only the white a colour carries is cooled: a pastel a little, a
    // saturated colour not at all.
    const pink = emittedRgb([255, 128, 128]);
    expect(pink[0]).toBeLessThan(255);
    expect(pink[0]).toBeGreaterThan(240);
    // ...and the wire never sees any of it (see the last test below).
  });

  it('leaves a violet the user actually picked as a violet', () => {
    // Red is leading too, so there is no blue-only spectral tail to model and
    // the correction has nothing to do. Picking purple must give purple.
    const [r, g, b] = emittedRgb([128, 0, 255]);
    expect(r).toBe(128);
    expect(b).toBe(255);
    expect(g).toBeLessThan(45); // still unmistakably violet, not blue
  });

  it('scales with how far blue is leading, with no step in it', () => {
    const green = (b: number) => emittedRgb([0, 0, b])[1];
    expect(green(255)).toBeGreaterThan(green(128));
    expect(green(128)).toBeGreaterThan(green(40));
  });

  it('is the same hue at every brightness — a dim blue is not a violet', () => {
    // Reported: "the blue (0-0-255) is purple" at the keyboard's level 1. The
    // azure lift scales with how far blue leads, and it used to be applied to
    // the DIMMED colour, so a dim blue barely got it.
    const hueOf = (rgba: string) => /(\d+), (\d+), (\d+)/.exec(rgba)!.slice(1).map(Number);
    expect(hueOf(litCap('rgb(0, 0, 136)')!.glow)).toEqual(hueOf(litCap('rgb(0, 0, 255)')!.glow));
  });

  it('never reaches a value the device is told', () => {
    // `led` is the raw colour, because a bare board paints a swatch of what
    // was chosen and the wire carries exactly that.
    expect(litCap('#0000ff')!.led).toBe('#0000ff');
  });
});
