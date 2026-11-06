/**
 * Re-extract the Attack Shark **keyboard** protocol from the installed
 * Driver v4 (Electron) app. Companion to extract-vendor-protocol.mjs, which
 * only ever pulled {vid,pid} tuples and raw FEA_CMD_* numbers out of this app
 * — everything semantic it produces is mouse-only.
 *
 *   npm run extract:kb
 *
 * Driver v4's renderer is shipped **unpacked** (no app.asar), so every source
 * chunk under resources/app/dist/js is readable. The renderer builds a
 * checksum-LESS payload and hands it to the native gRPC service
 * (iot_driver_v215.exe) over http://127.0.0.1:3814; that service appends the
 * Bit7/Bit8 byte and does the HID I/O. So the checksum arithmetic is NOT in
 * here — see docs/reverse-engineering/CAPTURE-KEYBOARD.md for the capture that
 * recovers it. Everything else (command set, key matrix, page map, option
 * tables, gRPC schema) is.
 *
 * Outputs:
 *   scripts/_raw/kb-*.json                 raw dumps, committed, diff on update
 *   src/shared/keyboard-options.ts         generated option tables (ported-from-vendor)
 *   ../docs/protocol/iot_driver.proto      the DriverGrpc surface
 *
 * The R85HE key matrix that comes out of here (scripts/_raw/kb-r85he-layout.json)
 * is transcribed by hand into src/shared/layouts.ts as ANSI_79_SG9047 — that
 * file is hand-maintained and imported by three processes.
 */
import fs from 'node:fs';
import path from 'node:path';

const KB_APP =
  process.env.ASHARK_KB_APP ||
  'C:/Users/' +
    (process.env.USERNAME || 'me') +
    '/AppData/Local/Programs/Attack Shark Driver v4/resources/app/dist/js';

const rawDir = path.resolve('scripts/_raw');
const sharedDir = path.resolve('src/shared');
const protoDir = path.resolve('../docs/protocol');
fs.mkdirSync(rawDir, { recursive: true });

const readJs = (f) => fs.readFileSync(path.join(KB_APP, f), 'utf8');
const listJs = () => fs.readdirSync(KB_APP).filter((f) => f.endsWith('.js'));

/** Balanced-bracket slice starting at the first `open` at/after `from`. */
function balanced(src, from, open) {
  const close = open === '[' ? ']' : '}';
  const s = src.indexOf(open, from);
  let d = 0;
  let j = s;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === open) d++;
    else if (c === close && --d === 0) {
      j++;
      break;
    }
  }
  return src.slice(s, j);
}

/** Find `name=[` / `name={` (minified top-level const) and return its literal. */
function findLiteral(src, name) {
  const re = new RegExp('[;,\\s})]' + name.replace(/\$/g, '\\$') + '=([\\[{])', 'g');
  const m = re.exec(src);
  if (!m) return null;
  return balanced(src, m.index + m[0].length - 1, m[1]);
}

/** Loosely JSON-ify a minified JS object literal: quote keys, !0/!1 -> bool. */
function loosen(js) {
  return js
    .replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/:\s*!0\b/g, ':true')
    .replace(/:\s*!1\b/g, ':false')
    .replace(/,\s*([}\]])/g, '$1');
}
const evalLiteral = (js) => JSON.parse(loosen(js));

// ---------------------------------------------------------------------------
// 1. device table  (var rL = [ {id,vid,pid,keyLayout,name,displayName,...}, ... ])
// ---------------------------------------------------------------------------
function extractDeviceTable(indexJs) {
  const lit = findLiteral(indexJs, 'rL');
  if (!lit) return [];
  const rows = [];
  // split on row starts; each row is a flat-ish object literal. keyLayout /
  // lightLayout are minified var refs — keep only the ones we can read.
  const starts = [...lit.matchAll(/\{id:\d+,vid:\d+,pid:\d+/g)].map((m) => m.index);
  for (let i = 0; i < starts.length; i++) {
    const chunk = lit.slice(starts[i], starts[i + 1] ?? lit.length);
    const f = (re) => chunk.match(re)?.[1] ?? null;
    rows.push({
      id: +f(/id:(\d+)/),
      vid: +f(/vid:(\d+)/),
      pid: +f(/pid:(\d+)/),
      keyLayout: f(/keyLayout:c\.([A-Za-z0-9_]+)/),
      name: f(/\bname:"([^"]*)"/),
      displayName: f(/displayName:"([^"]*)"/),
      company: f(/company:"([^"]*)"/),
      layer: chunk.match(/\blayer:(\d+)/) ? +chunk.match(/\blayer:(\d+)/)[1] : null,
      magnetic: /magnetism:!0/.test(chunk),
      hasSideLight: /sideLightLayout:/.test(chunk),
      screen: /screen:\{/.test(chunk),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2. FEA_CMD_* per generation  (keeps protocol generations apart)
// ---------------------------------------------------------------------------
function extractCmds() {
  const out = {};
  for (const f of listJs()) {
    const s = readJs(f);
    const re = /FEA_CMD_([A-Z0-9_]+)\s*=\s*(\d+)/g;
    const map = {};
    let m;
    while ((m = re.exec(s))) map[m[1]] = +m[2];
    if (Object.keys(map).length > 8) out[f] = map;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. lighting effect tables  (lightLayout `I`, sideLightLayout `vp`)
// ---------------------------------------------------------------------------
const CN_DIR = {
  向右: 'right',
  向左: 'left',
  向下: 'down',
  向上: 'up',
  向外: 'out',
  向内: 'in',
  逆时针: 'ccw',
  顺时针: 'cw',
  Z字形: 'zigzag',
  回形: 'spiral',
  图案1: 'pattern1',
  图案2: 'pattern2',
  图案3: 'pattern3',
  图案4: 'pattern4',
  图案5: 'pattern5',
};
function extractLighting(indexJs) {
  const parse = (name) => {
    const lit = findLiteral(indexJs, name);
    if (!lit) return null;
    const obj = evalLiteral(lit);
    obj.types = obj.types.map((t) => ({
      type: t.type,
      maxValue: t.maxValue ?? null,
      maxSpeed: t.maxSpeed ?? null,
      rgb: !!t.rgb,
      dazzle: !!t.dazzle,
      options: t.options ? t.options.map((o) => CN_DIR[o] || o) : undefined,
    }));
    return obj;
  };
  return { perKey: parse('I'), side: parse('vp') };
}

// ---------------------------------------------------------------------------
// 4. R85HE key matrix  (chunk 322d1e41.js: defaultMatrix / defaultFnMatrix)
// ---------------------------------------------------------------------------
const HID_NAME = {
  4: 'KeyA',
  5: 'KeyB',
  6: 'KeyC',
  7: 'KeyD',
  8: 'KeyE',
  9: 'KeyF',
  10: 'KeyG',
  11: 'KeyH',
  12: 'KeyI',
  13: 'KeyJ',
  14: 'KeyK',
  15: 'KeyL',
  16: 'KeyM',
  17: 'KeyN',
  18: 'KeyO',
  19: 'KeyP',
  20: 'KeyQ',
  21: 'KeyR',
  22: 'KeyS',
  23: 'KeyT',
  24: 'KeyU',
  25: 'KeyV',
  26: 'KeyW',
  27: 'KeyX',
  28: 'KeyY',
  29: 'KeyZ',
  30: 'Digit1',
  31: 'Digit2',
  32: 'Digit3',
  33: 'Digit4',
  34: 'Digit5',
  35: 'Digit6',
  36: 'Digit7',
  37: 'Digit8',
  38: 'Digit9',
  39: 'Digit0',
  40: 'Enter',
  41: 'Escape',
  42: 'Backspace',
  43: 'Tab',
  44: 'Space',
  45: 'Minus',
  46: 'Equal',
  47: 'BracketLeft',
  48: 'BracketRight',
  49: 'Backslash',
  51: 'Semicolon',
  52: 'Quote',
  53: 'Backquote',
  54: 'Comma',
  55: 'Period',
  56: 'Slash',
  57: 'CapsLock',
  58: 'F1',
  59: 'F2',
  60: 'F3',
  61: 'F4',
  62: 'F5',
  63: 'F6',
  64: 'F7',
  65: 'F8',
  66: 'F9',
  67: 'F10',
  68: 'F11',
  69: 'F12',
  70: 'PrintScreen',
  71: 'ScrollLock',
  72: 'Pause',
  73: 'Insert',
  74: 'Home',
  75: 'PageUp',
  76: 'Delete',
  77: 'End',
  78: 'PageDown',
  79: 'ArrowRight',
  80: 'ArrowLeft',
  81: 'ArrowDown',
  82: 'ArrowUp',
  224: 'ControlLeft',
  225: 'ShiftLeft',
  226: 'AltLeft',
  227: 'MetaLeft',
  228: 'ControlRight',
  229: 'ShiftRight',
  230: 'AltRight',
  231: 'MetaRight',
};

function findModelChunk(nameToFind) {
  // the loader maps a name to its chunk in a few minified shapes:
  //   <model>:()=>import("./<chunk>.js")
  //   ".../<name>.ts":()=>m(()=>import("./<chunk>.js")
  const res = [
    new RegExp(nameToFind + '(?:\\.ts)?"?:\\(\\)=>[^(]*?import\\("\\.\\/([0-9a-f]+\\.js)"'),
    new RegExp(
      nameToFind + '(?:\\.ts)?"?:\\(\\)=>\\w+\\(\\(\\)=>import\\("\\.\\/([0-9a-f]+\\.js)"',
    ),
  ];
  for (const f of listJs()) {
    const s = readJs(f);
    for (const re of res) {
      const m = s.match(re);
      if (m) return m[1];
    }
  }
  return null;
}

function extractR85heMatrix() {
  const chunkFile = findModelChunk('ry5088_sg9047_1m_8k') || '322d1e41.js';
  const s = readJs(chunkFile);
  const grab = (n) => {
    const m = s.match(new RegExp(n + '=\\[([0-9,]+)\\]'));
    return m ? m[1].split(',').map(Number) : null;
  };
  const defaultMatrix = grab('defaultMatrix');
  const defaultFnMatrix = grab('defaultFnMatrix');
  const defaultFnMacMatrix = grab('defaultFnMacMatrix');

  // decode defaultMatrix: 4 bytes/slot. `[19,3,x,0]` = unused matrix position.
  // `[0,0,kc,0]` = a plain key at HID usage kc. Anything else = a special
  // default binding (media/system) that ships on that physical key.
  const slots = [];
  for (let i = 0; i < defaultMatrix.length; i += 4) {
    const raw = defaultMatrix.slice(i, i + 4);
    const slot = i / 4;
    let kind = 'special';
    let code = null;
    if (raw[0] === 19 && raw[1] === 3) kind = 'unused';
    else if (raw[0] === 0 && raw[1] === 0 && raw[3] === 0 && raw[2] === 0) kind = 'empty';
    else if (raw[0] === 0 && raw[1] === 0 && raw[3] === 0) {
      kind = 'key';
      code = raw[2];
    }
    slots.push({
      slot,
      raw,
      kind,
      code,
      name: code != null ? HID_NAME[code] || `kc${code}` : null,
    });
  }
  return { chunkFile, defaultMatrix, defaultFnMatrix, defaultFnMacMatrix, slots };
}

/**
 * Every Attack Shark board's factory key matrix, keyed by vendor model id —
 * the same `defaultMatrix` lookup as `extractR85heMatrix`, for each row of
 * the device table. A board's slot map is what per-key writes need, so with
 * these an importer can promote a drawing-only layout to an addressable one
 * (match each key's `matrixEntry` to its one slot, as
 * src/main/devices/catalog/sharkfin-convert.ts `convertLayout` does).
 * Boards whose chunk is not found are listed, not guessed.
 */
function extractAllMatrices(devices) {
  const out = {};
  const missing = [];
  for (const d of devices.filter((x) => x.company === 'AttackShark' && x.name)) {
    const chunkFile = findModelChunk(d.name);
    if (!chunkFile) {
      missing.push(`${d.id} ${d.name}`);
      continue;
    }
    const m = readJs(chunkFile).match(/defaultMatrix=\[([0-9,]+)\]/);
    if (!m) {
      missing.push(`${d.id} ${d.name} (no defaultMatrix in ${chunkFile})`);
      continue;
    }
    out[d.id] = {
      name: d.name,
      keyLayout: d.keyLayout,
      chunkFile,
      defaultMatrix: m[1].split(',').map(Number),
    };
  }
  return { matrices: out, missing };
}

// ---------------------------------------------------------------------------
// 5. R85HE UI grid  (chunk keyboard_79_sg9047_keymappings_ui_info)
// ---------------------------------------------------------------------------
function extractR85heUi() {
  const chunkFile = findModelChunk('keyboard_79_sg9047_keymappings_ui_info');
  let s;
  if (chunkFile) {
    s = readJs(chunkFile);
  } else {
    // fall back: scan the small chunks for the exported literal
    for (const f of listJs()) {
      if (f.startsWith('index.')) continue;
      const t = readJs(f);
      if (t.includes('export{e as keyboard_79_sg9047_keymappings_ui_info}')) {
        s = t;
        break;
      }
    }
  }
  if (!s) return null;
  const m = s.match(/\{width:(\d+),height:(\d+),layout:(\{[\s\S]*?\})\}(?:;|export)/);
  if (!m) return null;
  const layout = evalLiteral(m[3]);
  return { width: +m[1], height: +m[2], layout };
}

// ---------------------------------------------------------------------------
// 6. magnetism page map + mode enum + travel multiplier  (5e635fe2.js)
// ---------------------------------------------------------------------------
function extractMagnetism() {
  const s = readJs('5e635fe2.js');
  const modeCases = [...s.matchAll(/case (\d+):e\.push\(\{\.\.\._,option:"(\w+)"/g)].map((m) => ({
    value: +m[1],
    mode: m[2],
  }));
  // getMultiMagnetismInfo(): which _getMulitMagnetismCMD(page, chunks) it calls.
  const g = s.match(/getMultiMagnetismInfo=async\(\)=>\{[\s\S]{0,1600}/)?.[0] ?? '';
  const pageCalls = [...g.matchAll(/_getMulitMagnetismCMD\((\d+),(\d+)\)/g)].map((m) => ({
    page: +m[1],
    chunks: +m[2],
  }));
  // dedupe, first mention wins
  const pages = [];
  for (const p of pageCalls) if (!pages.some((q) => q.page === p.page)) pages.push(p);
  return {
    modeEnum: modeCases,
    pages,
    // vendor get磁轴行程步进倍数(): usb ver undefined -> 10; [768,1280) -> 100; >=1280 -> 200
    travelMultiplierRule: '<768 || undefined -> 10; [768,1280) -> 100; >=1280 -> 200',
  };
}

// ---------------------------------------------------------------------------
// 7. gRPC DriverGrpc surface  ->  iot_driver.proto
// ---------------------------------------------------------------------------
function extractProto(indexJs) {
  const m = indexJs.match(/new \w+\("driver\.DriverGrpc",\[([\s\S]{0,3000}?)\]\)/);
  const methods = m
    ? [...m[1].matchAll(/\{name:"(\w+)",(serverStreaming:!0,)?options:\{\}/g)].map((x) => ({
        name: x[1],
        serverStreaming: !!x[2],
      }))
    : [];
  const enums = {};
  for (const [, body, ref] of indexJs.matchAll(/\(e=>\(([^)]*?)\)\)\((\w+)\|\|\{\}\)/g)) {
    const vals = [...body.matchAll(/e\.(\w+)=(\d+)\]="\1"/g)].map((x) => ({
      name: x[1],
      value: +x[2],
    }));
    if (vals.length) enums[ref] = vals;
  }
  return { methods, enums };
}

function writeProto(proto) {
  const csum = proto.enums.xs || [
    { name: 'Bit7', value: 0 },
    { name: 'Bit8', value: 1 },
    { name: 'None', value: 2 },
  ];
  const dangle = proto.enums.Ti || [
    { name: 'DangleDevTypeNone', value: 0 },
    { name: 'Keyboard', value: 1 },
    { name: 'Mouse', value: 2 },
  ];
  const lines = [
    'syntax = "proto3";',
    '// AUTO-EXTRACTED from Attack Shark Driver v4 dist/js. Regenerate: npm run extract:kb',
    '// The renderer talks to iot_driver_v215.exe over gRPC-web at http://127.0.0.1:3814.',
    '// Only the shape is recovered here; iot_driver appends the checksum named by',
    '// CheckSumType and performs the HID I/O.',
    'package driver;',
    '',
    'enum CheckSumType {',
    ...csum.map((e) => `  ${e.name} = ${e.value};`),
    '}',
    '',
    'enum DangleDevType {',
    ...dangle.map((e) => `  ${e.name} = ${e.value};`),
    '}',
    '',
    'message SendMsg {',
    '  string devicePath = 1;',
    '  bytes  msg = 2;            // frame WITHOUT the trailing checksum byte',
    '  CheckSumType checkSumType = 3;',
    '  DangleDevType dangleDevType = 4;',
    '}',
    'message ReadMsg { string devicePath = 1; bool is24 = 2; string path = 3; }',
    '',
    'service DriverGrpc {',
    ...proto.methods.map(
      (m) => `  rpc ${m.name}(SendMsg) returns (${m.serverStreaming ? 'stream ' : ''}ResSend);`,
    ),
    '}',
  ];
  fs.mkdirSync(protoDir, { recursive: true });
  fs.writeFileSync(path.join(protoDir, 'iot_driver.proto'), lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// generated src/shared/keyboard-options.ts
// ---------------------------------------------------------------------------
function writeKeyboardOptionsTs(lighting, magnetism, cmds) {
  const j = (v) => JSON.stringify(v);
  const he = cmds['5e635fe2.js'] || {};
  const ts =
    `// AUTO-EXTRACTED from Attack Shark Driver v4 (dist/js chunks 5e635fe2.js,\n` +
    `// index.b078bf5f.js). Do not edit. Regenerate: npm run extract:kb\n` +
    `// Provenance: ported-from-vendor — option sets and wire values the vendor\n` +
    `// software itself uses. The checksum and every reply offset still need a\n` +
    `// capture — see docs/reverse-engineering/CAPTURE-KEYBOARD.md.\n` +
    `// Pure data, no Node, so the renderer can label controls with it.\n\n` +
    `export interface KbLightEffect {\n` +
    `  type: string;\n  maxValue: number | null;\n  maxSpeed: number | null;\n` +
    `  rgb: boolean;\n  dazzle: boolean;\n  options?: string[];\n}\n\n` +
    `/** Per-key lighting effects (vendor \`lightLayout\`). */\n` +
    `export const KB_PERKEY_EFFECTS: KbLightEffect[] = ${j(lighting.perKey?.types ?? [])};\n\n` +
    `/** Side / edge lighting effects (vendor \`sideLightLayout\`). */\n` +
    `export const KB_SIDE_EFFECTS: KbLightEffect[] = ${j(lighting.side?.types ?? [])};\n\n` +
    `/** Magnetic key-mode enum (vendor \`_decodeMagnetismKeyModes\`). bit7 of the\n` +
    ` *  mode byte is the rapid-trigger ("fire") flag; bits0-6 are the mode. */\n` +
    `export const KB_MAGNETIC_MODES: { value: number; mode: string }[] = ${j(magnetism.modeEnum)};\n\n` +
    `/** Paged MULTI_MAGNETISM channels and how many 56-byte read chunks the\n` +
    ` *  vendor requests for each (SET_MULTI_MAGNETISM=101, GET=229). 2 bytes/key\n` +
    ` *  little-endian, indexed by the raw defaultMatrix slot, EXCEPT page 7 and\n` +
    ` *  page 10 (see notes). */\n` +
    `export const KB_MAGNETISM_PAGES = {\n` +
    `  MODES: 7,        // 1 byte/key: bit7 fire, bits0-6 mode\n` +
    `  TRAVEL: 0,       // press actuation\n` +
    `  RELEASE: 1,      // release point (normal mode)\n` +
    `  PAGE6: 6,        // third travel list (vendor 'r'); role TBD by capture\n` +
    `  RT_PRESS: 2,     // rapid-trigger re-press sensitivity (only if any key armed)\n` +
    `  RT_RELEASE: 3,   // rapid-trigger release sensitivity\n` +
    `  DKS_POINTS: 4,   // dynamic-keystroke actuation points\n` +
    `  DKS_DETAIL: 10,  // dynamic-keystroke per-zone key actions (4 bytes/key, 8 chunks)\n` +
    `  MT: 5,           // mode-tap data (only if any key in 'mt')\n` +
    `  SNAP: 9,         // SOCD / snap-tap data (only if any key in 'snap')\n` +
    `  DEADZONE: 251,   // top dead zone (only if supported)\n` +
    `  SWITCH_TYPE: 252,// installed switch id (only if switch is replaceable)\n` +
    `} as const;\n\n` +
    `/** Chunk counts the vendor reads per page. */\n` +
    `export const KB_MAGNETISM_PAGE_CHUNKS: Record<number, number> = ${j(
      Object.fromEntries(magnetism.pages.map((p) => [p.page, p.chunks])),
    )};\n\n` +
    `export const KB_TRAVEL_MULTIPLIER_RULE = ${j(magnetism.travelMultiplierRule)};\n\n` +
    // No KB_TRAVEL_RANGE here any more. It was never extracted from the
    // bundle - it was typed into this generator by hand, so regenerating
    // silently reinstated numbers a real board disagreed with. It is
    // hand-maintained in src/shared/keyboard-travel.ts instead.
    `/** HE command numbers not yet in compx-keyboard.ts KB_CMD (5e635fe2 gen). */\n` +
    `export const KB_HE_EXTRA_CMD = {\n` +
    `  SET_MAGNETISM_CAL: ${he.SET_MAGNETISM_CAL ?? 28},\n` +
    `  SET_MAGNETISM_MAXIMUM_CALIBRATION: ${he.SET_MAGNETISM_MAXIMUM_CALIBRATION ?? 30},\n` +
    `  SET_CMD_AUTOOSEN: ${he.SET_CMD_AUTOOSEN ?? 23},\n` +
    `  GET_CMD_AUTOOSEN: ${he.GET_CMD_AUTOOSEN ?? 151},\n` +
    `  SET_SKU: ${he.SET_SKU ?? 80},\n` +
    `  GET_SKU: ${he.GET_SKU ?? 208},\n` +
    `  GET_LEDONOFF: ${he.GET_LEDONOFF ?? 133},\n` +
    `} as const;\n\n` +
    `/** SET_KEYSTROKE / GET_KEYSTROKE only exist in the c5a66cc9 generation, not\n` +
    ` *  in the R85HE's 5e635fe2 class. Kept here so the capture can check whether\n` +
    ` *  the R85HE firmware answers them anyway. */\n` +
    `export const KB_KEYSTROKE_CMD_C5 = { SET: 35, GET: 163 } as const;\n`;
  fs.writeFileSync(path.join(sharedDir, 'keyboard-options.ts'), ts);
}

// ---------------------------------------------------------------------------
// build the hand-transcribable R85HE layout (slot <-> key <-> pixel xy)
// ---------------------------------------------------------------------------
function buildLayout(matrix, ui) {
  if (!ui) return null;
  const cell = 46; // ~40px key on a 46px pitch in the vendor grid
  const rows = [];
  for (const s of matrix.slots) {
    // plain keys, plus the Fn key (a firmware layer key: type 10 / param 1,
    // no HID usage — the vendor grid still lists it as "Fn").
    let name = s.name;
    let code = s.code;
    if (s.kind === 'special' && s.raw[0] === 10 && s.raw[1] === 1) {
      name = 'Fn';
      code = null;
    } else if (s.kind !== 'key') {
      continue;
    }
    const g = ui.layout[name];
    const entry = {
      slot: s.slot,
      code,
      name,
      label: g ? g.displayText[0] : name,
      // vendor grid position -> render grid units
      x: g ? +(g.x / cell).toFixed(2) : null,
      y: g ? +(g.y / cell).toFixed(2) : null,
      w: g ? +(g.width / cell).toFixed(2) : 1,
      // column-major matrix coords for the main 96-slot block
      mrow: s.slot < 96 ? s.slot % 6 : null,
      mcol: s.slot < 96 ? Math.floor(s.slot / 6) : null,
    };
    rows.push(entry);
  }
  return { gridWidth: ui.width, gridHeight: ui.height, cell, keys: rows };
}

// ---------------------------------------------------------------------------
try {
  const indexJs = readJs('index.b078bf5f.js');

  const devices = extractDeviceTable(indexJs);
  const cmds = extractCmds();
  const lighting = extractLighting(indexJs);
  const matrix = extractR85heMatrix();
  const ui = extractR85heUi();
  const magnetism = extractMagnetism();
  const proto = extractProto(indexJs);
  const layout = buildLayout(matrix, ui);

  const dump = (f, v) => fs.writeFileSync(path.join(rawDir, f), JSON.stringify(v, null, 1));
  dump('kb-devices.json', devices);
  dump('kb-fea-cmd.json', cmds);
  dump('kb-lighting.json', lighting);
  dump('kb-r85he-matrix.json', matrix);
  dump('kb-r85he-ui.json', ui);
  dump('kb-magnetism.json', magnetism);
  dump('kb-grpc.json', proto);
  if (layout) dump('kb-r85he-layout.json', layout);
  const all = extractAllMatrices(devices);
  dump('kb-matrices.json', all.matrices);
  console.log(
    `model matrices:   ${Object.keys(all.matrices).length} Attack Shark boards` +
      (all.missing.length ? `, not found: ${all.missing.join('; ')}` : ''),
  );

  writeKeyboardOptionsTs(lighting, magnetism, cmds);
  writeProto(proto);

  const heRows = devices.filter((d) => d.company === 'AttackShark' && d.magnetic);
  const collisions = devices.filter((d) => d.vid === 12625 && d.pid === 20521);
  console.log(`device rows:      ${devices.length}  (AttackShark magnetic: ${heRows.length})`);
  console.log(
    `  3151:5029 shared by ${collisions.length} models: ${collisions.map((d) => d.displayName).join(', ')}`,
  );
  console.log(`cmd generations:  ${Object.keys(cmds).join(', ')}`);
  console.log(
    `perkey effects:   ${lighting.perKey?.types.length}   side effects: ${lighting.side?.types.length}`,
  );
  console.log(
    `R85HE matrix:     ${matrix.defaultMatrix.length / 4} slots, ${matrix.slots.filter((s) => s.kind === 'key').length} keys  (chunk ${matrix.chunkFile})`,
  );
  console.log(`magnetism pages:  ${magnetism.pages.map((p) => `${p.page}x${p.chunks}`).join(' ')}`);
  console.log(
    `gRPC methods:     ${proto.methods.length}   enums: ${Object.keys(proto.enums).join(', ')}`,
  );
} catch (e) {
  console.error('keyboard extraction failed:', e.stack || e.message);
  console.error('Set ASHARK_KB_APP to Driver v4 …/resources/app/dist/js');
  process.exit(1);
}
