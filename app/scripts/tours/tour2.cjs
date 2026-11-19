// UNFINISHED: written for the 2026-11-19 re-recording, which was stopped before
// this story was ever run end to end. The README still shows the 2026-11-03
// recording of this tour. Not run by record.mjs.
// README tour 2 — the keyboard (Attack Shark R85HE): live key travel with rapid
// trigger, moving the actuation point, macros, rainbow lighting. Story, pacing,
// cursor path and camera zooms copied from the old
// docs/media/walkthrough/tour-2-keyboard.webp (times in ms).
//   electron tour2.cjs <outDir> [--frames=N]
const h = require('./harness.cjs');
const prep = require('./prep.cjs');

const PANE = '.config-content > .tabpane-in';
const rail = (text) => ({ sel: '.tabrail-nav button', text, fx: 0.3 });
// The Actuation slider: 0.1 mm at the top, 3.4 mm at the bottom (vertical-lr).
const actuation = (mm) => ({ sel: 'input.vslider', index: 0, fx: 0.5, fy: (mm - 0.1) / 3.3 });
const W_SLOT = 14;
const travel = (keys) =>
  `return window.__tour.travel(${JSON.stringify({ id: h.R85, slot: W_SLOT, keys })})`;
// The camera on the Key panel's switch diagram and sliders: a 2x view, its
// top-left at the panel's "Key W" heading.
const KEY_ZOOM = `
  const head = [...document.querySelectorAll('.panel > h4')].find((e) => e.getClientRects().length && /^Key(?!s)/.test(e.textContent.trim()));
  const p = head.parentElement.getBoundingClientRect();
  const hh = head.getBoundingClientRect();
  return [Math.round(p.left - 12), Math.round(hh.top - 18), 640, 400];
`;

h.run({
  name: 'tour-2-keyboard',
  totalMs: 37788,
  tabsBefore: [h.V8],
  prepare: async (s) => {
    console.log('prep', JSON.stringify(await prep.r85(s)));
    console.log('light', JSON.stringify(await prep.rainbow(s)));
    await prep.clearToasts(s);
  },
  start: 'logo',
  timeline: [
    { at: 270, dur: 600, to: { sel: '.grid .card', text: 'R85HE', fx: 0.5, fy: 0.42 } },
    { at: 950, click: true },
    { at: 3280, dur: 610, to: rail('Actuation') },
    { at: 3960, click: true },
    { at: 5700, dur: 670, to: { sel: '.kbkey', text: 'W', exact: true } },
    { at: 6450, click: true },
    { at: 6700, dur: 1100, scroll: { el: PANE, to: 99999 } },
    { at: 8380, dur: 460, to: [1102, 419] },
    { at: 9180, dur: 200, to: [1187, 390] },
    // Live key travel while the camera is in: presses and re-presses, rapid trigger.
    {
      at: 9600,
      run: travel([
        [0, 0],
        [350, 0.66],
        [700, 1.9],
        [1000, 2.66],
        [1400, 3.2],
        [1900, 3.2],
        [2300, 2.6],
        [2700, 1.5],
        [3000, 0.66],
        [3400, 0.3],
        [3700, 1.06],
        [4100, 1.43],
        [4500, 1.06],
        [4900, 2.78],
        [5300, 2.1],
        [5700, 0.51],
        [6000, 0],
      ]),
    },
    { at: 15700, run: `return window.__tour.travelStop()` },
    { at: 16350, dur: 740, to: actuation(0.4) },
    { at: 17150, down: true },
    { at: 17200, dur: 1960, to: actuation(1.59), ease: 'smooth' },
    { at: 20150, up: true },
    { at: 20170, dur: 730, to: [1190, 387] },
    {
      at: 21300,
      run: travel([
        [0, 0],
        [400, 0.8],
        [800, 1.2],
        [1100, 0.9],
        [1500, 0.4],
        [1900, 1.4],
        [2300, 2.1],
        [2700, 2.4],
        [3000, 1.7],
        [3300, 0.6],
        [3500, 0],
      ]),
    },
    { at: 24600, run: `return window.__tour.travelStop()` },
    { at: 24590, dur: 800, to: rail('Macros') },
    { at: 25470, click: true },
    { at: 27600, dur: 340, to: rail('Lighting') },
    { at: 28020, click: true },
    { at: 30820, dur: 800, to: { sel: 'button.effect-tile', text: 'Sine Wave', exact: true } },
    { at: 31950, click: true },
    { at: 33430, dur: 610, to: { sel: 'button.btn', text: 'Apply to keyboard' } },
    { at: 34400, click: true },
    { at: 36180, dur: 670, to: 'logo' },
    { at: 37000, click: true },
  ],
  zoom: [
    { at: 9150, dur: 500, rectCode: KEY_ZOOM },
    { at: 15750, dur: 900, rect: null },
    { at: 20600, dur: 900, rectCode: KEY_ZOOM },
    { at: 24150, dur: 650, rect: null },
  ],
});
