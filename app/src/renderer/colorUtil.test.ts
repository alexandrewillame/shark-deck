import { describe, expect, it } from 'vitest';
import {
  LED_PALETTE,
  LED_WHITE,
  SWATCH_HUES,
  emittedRgb,
  hexToRgb,
  hsvToRgb,
  ledFor,
  ledPresets,
  litCap,
  presetOf,
  rgbToHsv,
  shownRgb,
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
 * The LED presets: ten colour families across, three colours down each — the
 * colour, its neighbour round the wheel, a light one. They were three
 * BRIGHTNESSES of each colour (full, 72%, half), which the effect's own
 * brightness already does: "propose actually different colours, not lower
 * intensities" (2026-11-26).
 */
describe('the preset grid', () => {
  const flat = LED_PALETTE.flat();

  it('is ten families, three colours each, every colour and name once', () => {
    expect(LED_PALETTE).toHaveLength(3);
    for (const row of LED_PALETTE) expect(row).toHaveLength(SWATCH_HUES.length + 1);
    expect(new Set(flat.map((p) => p.look)).size).toBe(flat.length);
    expect(new Set(flat.map((p) => p.name)).size).toBe(flat.length);
  });

  it('heads each column with its family, the same families the key groups use', () => {
    expect(LED_PALETTE[0]!.slice(0, SWATCH_HUES.length).map((p) => p.name)).toEqual(
      SWATCH_HUES.map((h) => h.name),
    );
    expect(GROUP_HUES).toEqual(SWATCH_HUES.map((h) => h.name));
  });

  it('is never a dimmer copy: every colour but "off" runs its strongest die flat out', () => {
    for (const p of flat) {
      if (p.name === 'off') continue;
      expect(Math.max(...hexToRgb(p.look)), p.name).toBe(255);
    }
  });

  it('keeps black reachable, which is the only per-key off switch', () => {
    expect(flat.find((p) => p.name === 'off')?.look).toBe('#000000');
    expect(flat.find((p) => p.name === 'white')?.look).toBe('#ffffff');
  });

  it('keeps every pair of presets apart', () => {
    // Measured, not eyeballed. The closest pair is 12.1 (cream / pale lime); a
    // first draft had a chartreuse beside the green and an indigo beside the
    // blue, the same colour twice on a diode.
    for (let i = 0; i < flat.length; i++) {
      for (let j = i + 1; j < flat.length; j++) {
        const d = deltaEHex(flat[i]!.look, flat[j]!.look);
        expect(d, `${flat[i]!.name} vs ${flat[j]!.name} is only ${d.toFixed(1)}`).toBeGreaterThan(
          11.5,
        );
      }
    }
  });
});

/**
 * Main lighting lights a colour as a screen would; the side strip mixes light
 * linearly. On an R85 HE: #ff4d00 was red on the main lighting and a proper
 * orange on the strip; #ff7f32 orange on the main lighting and whitish on the
 * strip (2026-11-26). So each zone is sent what makes the colour shown.
 */
describe('the presets, per zone', () => {
  it('sends the main lighting the colour itself', () => {
    for (const p of LED_PALETTE.flat()) expect(ledFor(p.look, 'screen')).toBe(p.look);
  });

  it('sends the side strip what lights as that colour on a linear diode', () => {
    for (const p of LED_PALETTE.flat()) {
      const shown = shownRgb(hexToRgb(ledFor(p.look, 'linear')), 'linear');
      const meant = shownRgb(hexToRgb(p.look), 'screen');
      shown.forEach((c, i) => expect(Math.abs(c - meant[i]!), p.name).toBeLessThanOrEqual(1));
    }
  });

  it("puts the strip's orange where its owner found it: red full, green 50 to 100", () => {
    const [r, g, b] = hexToRgb(ledFor('#ff8000', 'linear'));
    expect([r, b]).toEqual([255, 0]);
    expect(g).toBeGreaterThanOrEqual(50);
    expect(g).toBeLessThanOrEqual(100);
  });

  it('names every preset in either zone, for its tooltip', () => {
    for (const zone of ['screen', 'linear'] as const)
      for (const row of ledPresets(zone))
        for (const p of row) expect(presetOf(p.hex, zone)?.name).toBe(p.name);
    expect(presetOf('#123456', 'screen')).toBeUndefined();
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

  it('leaves every saturated colour with no blue to speak of exactly alone', () => {
    for (const c of [
      [0, 0, 0],
      [255, 0, 0],
      [0, 255, 0],
      [0, 255, 255],
      [255, 180, 0],
      [255, 128, 0],
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

  it('draws red beside a full blue as the board shows it: a magenta reads violet', () => {
    // Side by side with the board: magenta "looks more like your violet", the
    // violet "a bit more blue" than drawn (2026-11-26). Still a violet, not a
    // blue: its red stays well up.
    const [mr, , mb] = emittedRgb([255, 0, 255]);
    expect(mb).toBe(255);
    expect(mr).toBeLessThan(200);
    expect(mr).toBeGreaterThan(120);
    const [vr, vg, vb] = emittedRgb([128, 0, 255]);
    expect(vb).toBe(255);
    expect(vr).toBeLessThan(128);
    expect(vr).toBeGreaterThan(50);
    expect(vg).toBeLessThan(vr);
  });

  it('leaves a pink, whose blue is low, as it was: "spot on"', () => {
    const [r] = emittedRgb([255, 128, 149]);
    expect(r).toBeGreaterThan(235);
  });

  it('draws a near-white as a white with a tint, a warm one yellow rather than orange', () => {
    // The warm white was "more orange-ish than in reality, where it looks
    // grey-ish, a bit grey-yellow" (2026-11-26).
    const warm = emittedRgb([255, 207, 154]);
    const [h, s] = rgbToHsv(warm);
    const [h0, s0] = rgbToHsv([255, 207, 154]);
    expect(s).toBeLessThan(s0);
    expect(h).toBeGreaterThan(h0 + 10); // towards yellow
    // ...and a cream still reads cream: a tint, not a white.
    const [cr, , cb] = emittedRgb([255, 244, 179]);
    expect(cr - cb).toBeGreaterThan(15);
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
