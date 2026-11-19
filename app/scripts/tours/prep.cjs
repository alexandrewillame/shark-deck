// The device state the old tours showed, set before recording through the app's
// own API (window.sharkdeck), as a user would have configured it. Only the
// simulated V8 / R85HE are touched (VirtualDriver), and only in this session.
const { V8, R85 } = require('./harness.cjs');

const APP_FS = require('path').resolve(__dirname, '..', '..').replace(/\\/g, '/');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The three macros the old tours' library showed (names and step counts). */
const MACROS = [
  {
    id: 'tour-burst-fire',
    name: 'Burst fire',
    repeatCount: 3,
    steps: [
      { type: 'mouse', action: 'down', value: 1 },
      { type: 'delay', ms: 18 },
      { type: 'mouse', action: 'up', value: 1 },
      { type: 'delay', ms: 42 },
    ],
  },
  {
    id: 'tour-gg',
    name: 'GG in chat',
    repeatCount: 1,
    steps: [
      { type: 'key', action: 'down', value: '28' },
      { type: 'delay', ms: 30 },
      { type: 'key', action: 'up', value: '28' },
      { type: 'delay', ms: 120 },
      { type: 'key', action: 'down', value: 'a' },
      { type: 'key', action: 'up', value: 'a' },
      { type: 'key', action: 'down', value: 'a' },
      { type: 'key', action: 'up', value: 'a' },
      { type: 'delay', ms: 60 },
      { type: 'key', action: 'down', value: '28' },
      { type: 'key', action: 'up', value: '28' },
    ],
  },
  {
    id: 'tour-copy-paste',
    name: 'Copy → paste',
    repeatCount: 1,
    steps: [
      { type: 'key', action: 'down', value: 'e0' },
      { type: 'key', action: 'down', value: '6' },
      { type: 'delay', ms: 40 },
      { type: 'key', action: 'up', value: '6' },
      { type: 'key', action: 'up', value: 'e0' },
      { type: 'delay', ms: 150 },
      { type: 'key', action: 'down', value: 'e0' },
      { type: 'key', action: 'down', value: '19' },
      { type: 'delay', ms: 40 },
      { type: 'key', action: 'up', value: '19' },
      { type: 'key', action: 'up', value: 'e0' },
    ],
  },
];

async function macros(s) {
  for (const m of MACROS)
    await s.js(
      `return (await window.sharkdeck.saveMacroLibraryEntry(${JSON.stringify(m)})).length`,
    );
}

/** Tour 1: the V8 as the old tour had it. */
async function v8(s) {
  const stages = [
    { index: 0, dpi: 400, color: [235, 64, 64], enabled: true },
    { index: 1, dpi: 800, color: [255, 150, 30], enabled: true },
    { index: 2, dpi: 1600, color: [40, 200, 230], enabled: true },
    { index: 3, dpi: 3200, color: [150, 90, 245], enabled: true },
  ];
  const out = {};
  out.dpi = await s.js(
    `return await window.sharkdeck.setDpiStages(${JSON.stringify(V8)}, ${JSON.stringify(stages)})`,
  );
  out.active = await s.js(
    `return await window.sharkdeck.setActiveDpiStage(${JSON.stringify(V8)}, 1)`,
  );
  // The factory mapping (the demo seed's option values decode as Left Click).
  const map = {
    1: { actionKey: 'button', action: 1, param: 0x0200 },
    2: { actionKey: 'button', action: 1, param: 0x0400 },
    3: { actionKey: 'button', action: 1, param: 0x1000 },
    4: { actionKey: 'button', action: 1, param: 0x0800 },
    5: { actionKey: 'dpiSwitch', action: 2, param: 0x0100 },
  };
  for (const [i, m] of Object.entries(map)) {
    out['b' + i] = await s.js(
      `return (await window.sharkdeck.setButtonMapping(${JSON.stringify(V8)}, ${i}, ${JSON.stringify(m)})).ok`,
    );
  }
  await macros(s);
  return out;
}

/** Tour 2: WASD as a red key group with rapid trigger, as the old tour had them. */
async function r85(s) {
  const out = await s.js(`
    const id = ${JSON.stringify(R85)};
    const d = (await window.sharkdeck.listDevices()).find((x) => x.id === id);
    const L = d.ui.keyMatrix.layout;
    const pick = (lab) => L.find((k) => (k.label || '').toUpperCase() === lab);
    const wasd = ['W', 'A', 'S', 'D'].map(pick);
    const groups = await window.sharkdeck.listKeyGroups(id, 1);
    // The Actuation tab makes the Default group on first open; before that
    // there is none, so make it the same way: every key, no colour.
    const all = L.map((k) => k.slot).filter((x) => x !== undefined);
    const def = groups.find((g) => g.name === 'Default') || groups[0] || { id: 'tour-default', name: 'Default', color: '', slots: all };
    const wasdSlots = wasd.map((k) => k.slot);
    const next = [
      { ...def, slots: def.slots.filter((x) => !wasdSlots.includes(x)) },
      { id: 'tour-group-1', name: 'Group #1', color: '#e8344e', slots: wasdSlots },
    ];
    const g = await window.sharkdeck.replaceKeyGroups(id, 1, next);
    const mag = await window.sharkdeck.readMagnetic(id);
    const keys = wasd.map((k) => {
      const cur = mag.find((m) => m.row === k.row && m.col === k.col) || { row: k.row, col: k.col };
      return { ...cur, row: k.row, col: k.col, actuationMm: 0.4, rapidTrigger: true, rtPressMm: 0.1, rtReleaseMm: 0.1, deadZoneMm: 0.3, deadZoneBottomMm: 0.3 };
    });
    const w = await window.sharkdeck.setMagneticKeys(id, keys);
    return { groups: g.map((x) => x.name + ':' + x.slots.length), wasd: wasd.map((k) => [k.label, k.slot, k.row, k.col]), write: w && w.ok, sample: keys[0] };
  `);
  await macros(s);
  return out;
}

/** The R85HE's main lighting in the rainbow variant of its effect (the old
 *  tour's board was lit in rainbow colours), through the app's setLighting. */
async function rainbow(s) {
  return s.js(`
    const id = ${JSON.stringify(R85)};
    const all = await window.sharkdeck.readLighting(id);
    const main = all.find((l) => l.zone === 'main') || all[0];
    const r = await window.sharkdeck.setLighting(id, { ...main, dazzle: true });
    return { zone: main.zone, effect: main.effect, ok: r && r.ok, zones: all.map((l) => l.zone + ':' + l.effect) };
  `);
}

/** Drop any toast the setup writes left, so frame 0 starts clean. */
async function clearToasts(s) {
  await sleep(300);
  return s.js(
    `const { useStore } = await import('/@fs/${APP_FS}/src/renderer/state/store.ts'); useStore.setState({ toasts: [] }); return true`,
  );
}

module.exports = { v8, r85, macros, rainbow, clearToasts, MACROS };
