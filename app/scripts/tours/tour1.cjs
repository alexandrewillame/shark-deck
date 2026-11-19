// README tour 1 — the mouse (Attack Shark V8): polling rate, sensor settings,
// angle snapping with its tooltip, mouse angle mode, key response time, then
// the Buttons, Macros and Lighting pages. Story, pacing and cursor path copied
// from the old docs/media/walkthrough/tour-1-mouse.webp (times in ms).
//   electron tour1.cjs <outDir> [--frames=N]
const h = require('./harness.cjs');
const prep = require('./prep.cjs');

const PANE = '.config-content > .tabpane-in';
const rail = (text) => ({ sel: '.tabrail-nav button', text, fx: 0.3 });
const rowPart = (row, sel, extra = {}) => ({ within: { sel: '.row', text: row }, sel, ...extra });
const angle = (deg) => ({ sel: 'input.angle-mode-slider', fx: (deg + 30) / 60, fy: 0.5 });

h.run({
  name: 'tour-1-mouse',
  totalMs: 34440,
  tabsBefore: [],
  prepare: async (s) => {
    console.log('prep', JSON.stringify(await prep.v8(s)));
    await prep.clearToasts(s);
  },
  // Where the old tour's pointer rests on Home, bottom right.
  start: [1051, 678],
  timeline: [
    { at: 200, dur: 600, to: { sel: '.grid .card', text: 'V8', fx: 0.5, fy: 0.45 } },
    { at: 900, click: true },
    { at: 3080, dur: 610, to: { sel: 'button.btn', text: '4K Hz', exact: true } },
    { at: 3760, click: true },
    { at: 4420, dur: 330, to: { sel: 'button.btn', text: '8K Hz', exact: true } },
    { at: 4800, click: true },
    {
      at: 5900,
      dur: 800,
      scroll: { el: PANE, to: { sel: '.panel > h4', text: 'Sensor' }, offset: 14 },
    },
    { at: 7300, dur: 540, to: rowPart('Angle snapping', '.panel-tip') },
    { at: 9580, dur: 470, to: rowPart('Angle snapping', 'button.toggle') },
    { at: 10120, click: true },
    { at: 11050, dur: 300, to: rowPart('Mouse angle mode', 'button.toggle') },
    { at: 11420, click: true },
    { at: 12460, dur: 400, to: angle(15) },
    { at: 12900, down: true },
    { at: 12950, dur: 2120, to: angle(-18), ease: 'smooth' },
    { at: 16950, dur: 3080, to: angle(12), ease: 'smooth' },
    { at: 20080, up: true },
    { at: 20120, dur: 420, to: [1050, 499] },
    { at: 20700, dur: 1200, scroll: { el: PANE, to: 99999 } },
    {
      at: 22380,
      dur: 530,
      to: { within: { sel: '.panel > h4', text: 'Key response time' }, sel: '.panel-tip' },
    },
    { at: 24390, dur: 730, to: rail('Buttons') },
    { at: 25250, click: true },
    { at: 27340, dur: 300, to: rail('Macros') },
    { at: 27720, click: true },
    { at: 29950, dur: 250, to: rail('Lighting') },
    { at: 30300, click: true },
    { at: 32630, dur: 600, to: 'logo' },
    { at: 33450, click: true },
    { at: 33950, dur: 450, to: [1051, 678] },
  ],
});
