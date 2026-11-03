/**
 * Re-extract the ROYUAN / Attack Shark **keyboard** protocol from qmk.top
 * ("GearHub-V5"), the vendor's own WebHID configurator.
 *
 *   npm run extract:qmk              # fetch the live bundle
 *   npm run extract:qmk -- --file X  # re-parse a saved bundle (offline)
 *   npm run extract:qmk -- --save    # keep a copy of the bundle in _raw/
 *
 * Why this source beats Driver v4 (extract-keyboard-protocol.mjs):
 *
 *   Driver v4's renderer builds a checksum-LESS payload and hands it to the
 *   native gRPC service, so the checksum arithmetic is NOT in it — it had to be
 *   recovered from a USB capture. qmk.top is pure WebHID: every byte the device
 *   sees is built in JavaScript, so the bundle contains the framing, the
 *   checksum, the full command table, the magnetic-switch parameter model, the
 *   per-device capability records AND the key layouts.
 *
 * The bundle is one file with no dynamic imports. Its name is content-hashed
 * (index.<hash>.js) and changes on every vendor deploy, so we always resolve it
 * from index.html — never hardcode it.
 *
 * Structure we rely on (all of it survives minification):
 *
 *   - Opcodes are per-class instance fields: `h(this,"FEA_CMD_SET_KEYMATRIX",10)`
 *     inside `class yn extends yD{...}`. The class chain is
 *     pD -> gD -> mD -> yD -> yn, later assignment wins, and `yn` is the only
 *     keyboard class ever constructed. That is what resolves the notorious
 *     "two colliding command sets": family B (yn) is the live one.
 *   - The magnetic parameter page map is an object literal keyed in Chinese
 *     (`PARAMETER_磁轴`), and the per-key mode byte is packed/unpacked by
 *     `___utils_磁轴OptionToNum` / `___utils_磁轴NumToOption`.
 *   - Layouts are plain arrays of {code,value,x,y,w,h} reached through
 *     `___findDeviceLayout(layoutName)`. **Array order is slot order.**
 *
 * Outputs (all committed, so a vendor deploy shows up as a reviewable diff):
 *   scripts/_raw/qmk-commands.json    per-class + merged effective opcode table
 *   scripts/_raw/qmk-devices.json     device records (id/vid/pid/layout/caps)
 *   scripts/_raw/qmk-layouts.json     every layout array, in slot order
 *   scripts/_raw/qmk-magnetism.json   page map, mode byte, travel encoding
 *
 * This is a DEV-TIME script. Nothing here is imported by main/preload/renderer,
 * so the app's "no network" invariant is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = process.env.QMK_ORIGIN || 'https://qmk.top';
const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1];
};

const rawDir = path.resolve('scripts/_raw');
fs.mkdirSync(rawDir, { recursive: true });

const write = (name, data) => {
  const p = path.join(rawDir, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 1) + '\n');
  console.log(`  wrote ${path.relative(process.cwd(), p)}`);
};

// ---------------------------------------------------------------------------
// bundle acquisition
// ---------------------------------------------------------------------------

async function loadBundle() {
  const local = argOf('--file');
  if (local) {
    console.log(`reading ${local}`);
    return { src: fs.readFileSync(local, 'utf8'), url: local };
  }

  console.log(`fetching ${ORIGIN}/ ...`);
  const html = await (await fetch(ORIGIN + '/')).text();
  // <script type="module" crossorigin src="/js/index.BdiCnJCK.js"></script>
  const hits = [...html.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
  if (!hits.length) throw new Error('no <script src> in index.html — site layout changed');
  // The app bundle is the biggest one; in practice there is exactly one.
  const rel = hits.find((h) => /index\./.test(h)) ?? hits[0];
  const url = new URL(rel, ORIGIN).href;
  console.log(`fetching ${url} ...`);
  const src = await (await fetch(url)).text();
  console.log(`  ${(src.length / 1024 / 1024).toFixed(2)} MiB`);
  if (argv.includes('--save')) {
    const p = path.join(rawDir, 'qmk-bundle.js');
    fs.writeFileSync(p, src);
    console.log(`  saved ${path.relative(process.cwd(), p)}`);
  }
  return { src, url };
}

// ---------------------------------------------------------------------------
// shared literal helpers (same shape as extract-keyboard-protocol.mjs)
// ---------------------------------------------------------------------------

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
    .replace(/([{,[])\s*([A-Za-z_$\u4e00-\u9fff][\w$\u4e00-\u9fff]*)\s*:/g, '$1"$2":')
    .replace(/:\s*!0\b/g, ':true')
    .replace(/:\s*!1\b/g, ':false')
    .replace(/:\s*(-?)\.(\d)/g, ':$10.$2') // JS `.1` is not valid JSON
    .replace(/,\s*([}\]])/g, '$1');
}

/**
 * Slice a method body by name. Base classes declare no-op stubs
 * (`h(this,"setReportRate",async e=>{})`) that are overridden further down, so
 * take the first occurrence whose body actually contains `must`.
 */
function bodyOf(src, name, must, len = 700) {
  for (const m of src.matchAll(new RegExp('"' + name + '"', 'g'))) {
    const body = src.slice(m.index, m.index + len);
    if (!must || body.includes(must)) return body;
  }
  return null;
}
const tryParse = (js) => {
  try {
    return JSON.parse(loosen(js));
  } catch {
    return null;
  }
};

/** Expand the object literal enclosing `pos` by brace counting, both ways. */
function enclosingObject(src, pos) {
  let s = pos;
  let d = 0;
  while (s > 0) {
    const c = src[s];
    if (c === '}') d++;
    else if (c === '{') {
      if (d === 0) break;
      d--;
    }
    s--;
  }
  let e = pos;
  d = 0;
  while (e < src.length) {
    const c = src[e];
    if (c === '{') d++;
    else if (c === '}') {
      if (d === 0) break;
      d--;
    }
    e++;
  }
  return src.slice(s, e + 1);
}

// ---------------------------------------------------------------------------
// 1. command table, per class + merged
// ---------------------------------------------------------------------------

/**
 * The class chain a keyboard actually runs. `yn` is the only keyboard class
 * that is ever `new`ed; everything above it contributes the opcodes `yn` does
 * not override. Order matters: later wins.
 */
const KB_CHAIN_DEPTH = 5;

function extractCommands(src) {
  const classes = [];
  const cr = /class\s+([A-Za-z_$][\w$]*)\s+extends\s+([A-Za-z_$][\w$]*)\s*\{/g;
  let m;
  while ((m = cr.exec(src))) classes.push({ name: m[1], ext: m[2], idx: m.index });

  const classAt = (i) => {
    let best = null;
    for (const c of classes) {
      if (c.idx < i) best = c;
      else break;
    }
    return best;
  };

  // helper name (`h`) is minifier-chosen — match on the shape, not the name.
  const dr = /\(this,\s*"(FEA_CMD_[A-Z0-9_]+)"\s*,\s*(\d+)\)/g;
  const perClass = {};
  while ((m = dr.exec(src))) {
    const c = classAt(m.index);
    const key = c ? c.name : '(top-level)';
    (perClass[key] ??= { extends: c?.ext ?? null, commands: {} }).commands[m[1]] = +m[2];
  }

  // Walk the inheritance chain that ends at the constructed keyboard class.
  const constructed = [
    ...new Set([...src.matchAll(/new\s+([A-Za-z_$][\w$]*)\(new\s/g)].map((x) => x[1])),
  ];
  const byName = Object.fromEntries(classes.map((c) => [c.name, c]));
  const kbLeaf =
    constructed.find((n) => {
      let cur = byName[n];
      for (let i = 0; i < KB_CHAIN_DEPTH + 2 && cur; i++) {
        if (perClass[cur.name]?.commands?.FEA_CMD_SET_MULTI_MAGNETISM) return true;
        cur = byName[cur.ext];
      }
      return false;
    }) ?? 'yn';

  const chain = [];
  for (let cur = byName[kbLeaf]; cur; cur = byName[cur.ext]) {
    chain.unshift(cur.name);
    if (chain.length > 12) break;
  }

  const effective = {};
  const origin = {};
  for (const c of chain) {
    for (const [k, v] of Object.entries(perClass[c]?.commands ?? {})) {
      effective[k] = v;
      origin[k] = c;
    }
  }

  const table = Object.entries(effective)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([name, value]) => ({
      name,
      value,
      hex: '0x' + value.toString(16).padStart(2, '0'),
      definedIn: origin[name],
    }));

  return { keyboardClass: kbLeaf, chain, effective: table, perClass };
}

// ---------------------------------------------------------------------------
// 2. transport: report ids + checksum
// ---------------------------------------------------------------------------

function extractTransport(src) {
  const num = (re) => {
    const m = src.match(re);
    return m ? +m[1] : null;
  };
  const enc = src.indexOf('___encodeCmd');
  const encBody = enc > -1 ? src.slice(enc, enc + 600) : '';
  const ckSlot = (mode) => {
    const m = encBody.match(
      new RegExp(
        `${mode}\\)?\\s*\\{?\\s*(?:const\\s+)?\\w+=\\w+\\(\\[\\.\\.\\.\\w+\\]\\.slice\\(0,(\\d+)\\)\\);?\\w+\\[(\\d+)\\]`,
      ),
    );
    return m ? { sumUpTo: +m[1], index: +m[2] } : null;
  };
  return {
    usbReportId: num(/"DEFAULT_REPORT_ID",(\d+)\)/),
    usbReportCount: num(/"DEFAULT_REPORT_COUNT",(\d+)\)/),
    btReportId: num(/"DEFAULT_BT_REPORT_ID",(\d+)\)/),
    btReportCount: num(/"DEFAULT_BT_REPORT_COUNT",(\d+)\)/),
    btPrefix: /new Uint8Array\(\[85,\.\.\./.test(encBody) ? 0x55 : null,
    checksum: {
      formula: '0xFF - (sum(bytes) & 0xFF)',
      bit7: ckSlot('Bit7') ?? { sumUpTo: 7, index: 7 },
      bit8: ckSlot('Bit8') ?? { sumUpTo: 8, index: 8 },
      note:
        'Offsets are into the 64-byte vendor payload, i.e. AFTER the leading HID ' +
        'report id. SharkDeck frames include the report id at [0], so Bit7 == ' +
        'compxFeaCkIndex 8 and Bit8 == 9.',
    },
    minPaddedLength: num(/e\.length>(\d+)\?e:/),
  };
}

// ---------------------------------------------------------------------------
// 3. magnetic-switch model
// ---------------------------------------------------------------------------

const PAGE_EN = {
  触发行程: 'pressActuation',
  松开行程: 'releasePoint',
  RT按下行程: 'rapidTriggerPress',
  RT松开行程: 'rapidTriggerRelease',
  DKS顶部触发行程: 'dksActuationPoints',
  MT长按时间: 'modTapHoldTime',
  底部死区: 'deadZoneBottom',
  磁轴Option: 'modeByte',
  DKS触发标志: 'dksZoneActions',
  SCOD对位号: 'socdPartnerSlot',
  所有按键DKS触发标志: 'dksZoneActionsAllKeys',
  按键按压行程数值: 'liveTravel',
  顶部死区: 'deadZoneTop',
  轴体: 'switchType',
};

function extractMagnetism(src) {
  const out = {};

  const pi = src.indexOf('PARAMETER_磁轴');
  if (pi > -1) {
    const lit = balanced(src, pi, '{');
    const parsed = tryParse(lit) ?? {};
    out.pages = Object.entries(parsed).map(([cn, page]) => ({
      page,
      vendorName: cn,
      name: PAGE_EN[cn] ?? null,
    }));
    out.pages.sort((a, b) => a.page - b.page);
  }

  // mode byte: bit flags + low-nibble option enum
  const ni = src.indexOf('___utils_磁轴NumToOption');
  if (ni > -1) {
    const body = src.slice(ni, ni + 900);
    const modes = [...body.matchAll(/case (\d+):\w+="([a-z_\u4e00-\u9fff]+)"/g)].map((m) => ({
      value: +m[1],
      mode: m[2],
    }));
    const bit = (re) => {
      const m = body.match(re);
      return m ? +m[1] : null;
    };
    out.modeByte = {
      rapidTriggerBit: bit(/\(\w+&(\d+)\)===\d+,\w+=\(\w+&64\)/) ?? 128,
      fullBottomBit: 64,
      optionMask: 15,
      modes,
      note:
        'bit7 = rapid trigger armed, bit6 = full bottom-out, low nibble = mode. ' +
        'RT is INDEPENDENT of snap/SOCD mode.',
    };
  }

  // travel step: {type:"0.1",精度:.1,倍数:10}
  const si = src.indexOf('"行程步进"');
  if (si > -1) {
    const lit = balanced(src, si, '{');
    const parsed = tryParse(lit);
    if (parsed && parsed.倍数 != null) {
      out.travelStep = {
        default: { type: parsed.type, precision: parsed.精度, multiplier: parsed.倍数 },
        encoding: {
          u8: 'value = travel_mm * 10 - 1',
          u16: 'value = round(travel_mm * multiplier), little-endian',
          deadZoneBottomU8: 'value = 40 - deadzone_mm * 10 - 1  (inverted)',
          dksU16: 'value = (dynamicTravel - 0.2) * multiplier',
        },
      };
    }
  }

  // named presets (comfort/sensitive/gaming/custom)
  const kb = bodyOf(src, 'setKeyMagnetismMode', 'case');
  if (kb) {
    out.keyMagnetismMode = Object.fromEntries(
      [...kb.matchAll(/case"([a-z]+)":\w+\[1\]=(\d+)/g)].map((m) => [m[1], +m[2]]),
    );
  }

  // frame shapes, transcribed from ___cmdSetAllMagnetAxis / ___cmdSetMagnetAxisSimple
  out.frames = {
    setAllKeys: '[SET_MULTI_MAGNETISM, page, 1, chunkIdx, isLastChunk, 0, 0, ck, ...56 bytes]',
    setOneKey: '[SET_MULTI_MAGNETISM, page, 0, slot, commit, 0, 0, ck, ...values]',
    get: '[GET_MULTI_MAGNETISM, page, 1, chunkIdx, 0, 0, 0, ck]',
    chunkPayload: 56,
  };

  return out;
}

// ---------------------------------------------------------------------------
// 4. report rate map
// ---------------------------------------------------------------------------

/**
 * `setReportRate` is declared in several classes: no-op stubs, a dongle variant
 * that skips 250 Hz, and the keyboard's own. Scan them all and keep the richest
 * table — that is the keyboard's. Variants are reported so a future firmware
 * that changes the mapping is visible in the diff rather than silently picked.
 */
function extractReportRates(src) {
  const maps = [];
  for (const m of src.matchAll(/"setReportRate"/g)) {
    // Bound to this method's own switch block, or a neighbouring function's
    // (which maps the other direction) bleeds in and collides on the keys.
    const sw = src.indexOf('switch(', m.index);
    if (sw === -1 || sw - m.index > 200) continue;
    const body = balanced(src, sw, '{');
    const map = {};
    for (const c of body.matchAll(/case (\d+(?:e\d+)?):\w+=(\d+);/g)) {
      map[Number(c[2])] = Number(c[1]);
    }
    if (Object.keys(map).length) maps.push(map);
  }
  if (!maps.length) return null;
  const uniq = [...new Map(maps.map((m) => [JSON.stringify(m), m])).values()];
  uniq.sort((a, b) => Object.keys(b).length - Object.keys(a).length);
  return {
    byteIndex: 2,
    indexToHz: uniq[0],
    otherVariants: uniq.slice(1),
  };
}

// ---------------------------------------------------------------------------
// 5. device records
// ---------------------------------------------------------------------------

function extractDevices(src) {
  const seen = new Set();
  const rows = [];
  // Anchor on displayName rather than layoutName: the table also holds mice,
  // audio and non-HE keyboards, and only HE boards carry a layoutName string.
  for (const m of src.matchAll(/displayName:"/g)) {
    const lit = enclosingObject(src, m.index);
    if (!/\bvid:\d+/.test(lit)) continue; // skip non-device objects
    const key = lit.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const f = (re) => lit.match(re)?.[1] ?? null;
    const n = (re) => {
      const v = lit.match(re)?.[1];
      return v == null ? null : +v;
    };
    const other = (() => {
      const oi = lit.indexOf('other:{');
      if (oi === -1) return null;
      return tryParse(balanced(lit, oi + 6, '{'));
    })();
    rows.push({
      id: n(/\bid:(\d+)/),
      vid: n(/\bvid:(\d+)/),
      pid: n(/\bpid:(\d+)/),
      name: f(/\bname:"([^"]*)"/),
      displayName: f(/displayName:"([^"]*)"/),
      company: f(/company:"([^"]*)"/),
      type: f(/\btype:"([^"]*)"/),
      layoutName: f(/layoutName:"([^"]*)"/),
      layer: n(/\blayer:(\d+)/),
      magnetism: /magnetism:!0/.test(lit),
      hasSideLight: /sideLightLayout:/.test(lit),
      other,
    });
  }
  rows.sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  return rows;
}

// ---------------------------------------------------------------------------
// 6. key layouts  (___findDeviceLayout: name -> minified array const)
// ---------------------------------------------------------------------------

function extractLayouts(src) {
  const i = src.indexOf('___findDeviceLayout');
  if (i === -1) return {};
  const body = src.slice(i, i + 4000);
  const pairs = [...body.matchAll(/===?"([A-Za-z0-9_·\u4e00-\u9fff]+)"\?([A-Za-z_$][\w$]*)/g)];
  const out = {};
  for (const [, layoutName, varName] of pairs) {
    const lit = findLiteral(src, varName);
    if (!lit) {
      out[layoutName] = { var: varName, error: 'literal not found' };
      continue;
    }
    // Most layouts are pure literals. A few compute coordinates from a nearby
    // minified const (`x:ta-40`), which JSON cannot represent — fall back to a
    // per-key regex that still recovers the load-bearing fields (order = slot,
    // `code`, and the HID usage in `value`).
    const keys =
      tryParse(lit) ??
      [...lit.matchAll(/\{code:"([^"]*)",value:(-?\d+)((?:,[a-z]:[^,{}]*)*)\}/g)].map((k) => {
        const geo = Object.fromEntries(
          [...k[3].matchAll(/,([a-z]):(-?\d+(?:\.\d+)?)\b(?![\w$-])/g)].map((g) => [g[1], +g[2]]),
        );
        return { code: k[1], value: +k[2], ...geo };
      });
    if (!Array.isArray(keys) || keys.length === 0) {
      out[layoutName] = { var: varName, error: 'not parseable as array' };
      continue;
    }
    // Array order IS slot order — this is what KeyLayoutEntry.slot means.
    out[layoutName] = {
      var: varName,
      keyCount: keys.length,
      keys: keys.map((k, slot) => ({
        slot,
        code: k.code,
        hid: k.value,
        x: k.x,
        y: k.y,
        w: k.w,
        h: k.h,
      })),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------

const main = async () => {
  const { src, url } = await loadBundle();
  const meta = {
    source: url,
    extractedAt: new Date().toISOString().slice(0, 10),
    bytes: src.length,
  };

  console.log('extracting...');

  const commands = extractCommands(src);
  const transport = extractTransport(src);
  write('qmk-commands.json', { ...meta, transport, ...commands });
  console.log(
    `  commands: ${commands.effective.length} effective (chain ${commands.chain.join(' -> ')})`,
  );

  const magnetism = extractMagnetism(src);
  write('qmk-magnetism.json', { ...meta, reportRate: extractReportRates(src), ...magnetism });
  console.log(`  magnetism: ${magnetism.pages?.length ?? 0} parameter pages`);

  const devices = extractDevices(src);
  write('qmk-devices.json', devices);
  console.log(
    `  devices: ${devices.length} (${devices.filter((d) => d.magnetism).length} magnetic)`,
  );

  const layouts = extractLayouts(src);
  write('qmk-layouts.json', layouts);
  console.log(`  layouts: ${Object.keys(layouts).length}`);

  const unresolved = Object.entries(layouts).filter(([, v]) => v.error);
  if (unresolved.length) {
    console.log(
      `  ! ${unresolved.length} layout(s) unresolved: ${unresolved.map(([k]) => k).join(', ')}`,
    );
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
