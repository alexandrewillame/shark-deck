/**
 * Re-extract the Attack Shark protocol from the installed vendor apps into the
 * committed data files under src/main/devices/. Run after a vendor update:
 *
 *   npm run extract
 *
 * Then review the git diff — every change to a frame constant or the device
 * table is a protocol change worth understanding before shipping.
 */
import fs from 'node:fs';
import path from 'node:path';

const KB_APP =
  process.env.ASHARK_KB_APP ||
  'C:/Users/' +
    (process.env.USERNAME || 'me') +
    '/AppData/Local/Programs/Attack Shark Driver v4/resources/app/dist/js';
const HUB_APP =
  process.env.ASHARK_HUB_APP ||
  'C:/Program Files (x86)/ATTACK  SHARK MOUSE HUB/ATTACK  SHARK MOUSE HUB';

const outDir = path.resolve('src/main/devices');
const rawDir = path.resolve('scripts/_raw');
fs.mkdirSync(rawDir, { recursive: true });

function readAllJs(dir) {
  let s = '';
  for (const f of fs.readdirSync(dir))
    if (f.endsWith('.js')) s += '\n' + fs.readFileSync(path.join(dir, f), 'utf8');
  return s;
}

// --- device table ---------------------------------------------------------
function extractDevices(js) {
  const re =
    /\{vid:(\d+),pid:(\d+)(?:,usage:(\d+))?(?:,usage_page:(\d+))?(?:,reportRate:([0-9e.]+))?\}/g;
  const seen = new Set();
  const rows = [];
  let m;
  while ((m = re.exec(js))) {
    const r = {
      vid: +m[1],
      pid: +m[2],
      usage: m[3] ? +m[3] : null,
      usage_page: m[4] ? +m[4] : null,
      reportRate: m[5] ? Number(m[5]) : null,
    };
    const k = `${r.vid}:${r.pid}:${r.usage}:${r.usage_page}`;
    if (!seen.has(k)) {
      seen.add(k);
      rows.push(r);
    }
  }
  return rows;
}

// --- FEA_CMD constants (per file, to keep protocol generations separate) --
function extractCmds(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    const re = /FEA_CMD_([A-Z0-9_]+)\s*=\s*(\d+)/g;
    let m;
    const map = {};
    while ((m = re.exec(s))) map[m[1]] = +m[2];
    if (Object.keys(map).length > 8) out[f] = map;
  }
  return out;
}

// --- sensor DPI tables --------------------------------------------------
function extractSensors(header) {
  const re = /#define\s+SENSOR_(\w+?)_DPI_(\d+)\s+0x([0-9A-Fa-f]+)/g;
  let m;
  const s = {};
  while ((m = re.exec(header))) {
    (s[m[1]] ||= {})[+m[2]] = parseInt(m[3], 16);
  }
  return s;
}

// --- mouse option tables (vendor Mouse Hub Language/en.json) ------------
// The Hub's localisation file is the only place the V8's real option sets and
// their wire values are written down: LOD is 0.7/1/2 mm as wire 3/1/2, poll
// rates are a bitmask (8/4/2/1/16/32/64), etc.
function readHubLang(hubDir) {
  const p = path.join(hubDir, 'Language', 'en.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** {option:"0.7 mm", value:3} -> {mm:0.7, wire:3} */
function parseLod(list) {
  return list.map((o) => ({
    mm: parseFloat(String(o.option).replace(/[^\d.]/g, '')),
    wire: o.value,
  }));
}
/** {rate:125, value:8} -> {hz:125, wire:8} */
function parseRates(list) {
  return list.map((o) => ({ hz: o.rate, wire: o.value }));
}
/** generic {value|command, option} -> {value, label} */
function parseEnum(list) {
  return list.map((o) => ({ value: o.value ?? o.command, label: o.option ?? o.label }));
}
/** KeyOptions: flat top-level actions only (back-compat shape). */
function parseButtonActions(list) {
  return list
    .filter((o) => !o.children || o.children.length === 0 || o.value === '1' || o.value === '2')
    .map((o) => ({ value: o.value, label: o.label }));
}
/**
 * KeyOptions, WITH the nested sub-action trees preserved — the vendor's own
 * translations of Left/Right/Wheel Click, DPI +/-, Scroll L/R/U/D and the 18
 * multimedia keys. Consumed by `shared/mouse-buttons.ts` (BUTTON_ACTIONS_TREE)
 * for the button remap UI's sub-pickers. Child `value` is the vendor hex
 * string ("0x0100"); we keep it verbatim.
 */
function parseButtonActionTree(list) {
  return list.map((o) => ({
    value: o.value,
    label: o.label,
    children: (o.children ?? []).map((c) => ({ value: c.value, label: c.label })),
  }));
}

function extractMouseOptions(hubDir) {
  const j = readHubLang(hubDir);
  const s = j.mouse.sensor;
  const l = j.mouse.light;
  return {
    lod: parseLod(s.LODOptions),
    pollRates: parseRates(s.ReportRates),
    sensorModes: parseEnum(s.SensorModeOptions),
    performanceTimeouts: parseEnum(s.PerformanceOptions),
    dpiLedEffects: parseEnum(l.DPIEffectOptions),
    lightModes: parseEnum(l.LightModeOptions),
    lightOffTimeouts: parseEnum(l.LightOffTimeOptions),
    receiverIndication: parseEnum(l.receiverList),
    buttonActions: parseButtonActions(j.mouse.key.KeyOptions),
    buttonActionTree: parseButtonActionTree(j.mouse.key.KeyOptions),
    dpiDynamicModes: parseEnum(j.mouse.AdvancedSettings?.dpiModeOptions ?? []),
  };
}

// --- per-model spec (vendor Mouse Hub usersetting/Config.ini) ----------
function extractMouseConfigIni(hubDir) {
  const p = path.join(hubDir, 'usersetting', 'Config.ini');
  const text = fs.readFileSync(p, 'utf8');
  const drive1 = text.split(/\[Drive1\]/)[1]?.split(/\[Drive2\]/)[0] ?? '';
  const num = (k) => {
    const m = drive1.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm'));
    return m
      ? m[1]
          .split(',')
          .map((v) => parseInt(v.trim(), 10))
          .filter((n) => !Number.isNaN(n))
      : [];
  };
  const grade = num('DPIGrade');
  const colorFlat = num('DPIColor');
  const stageColors = [];
  for (let i = 0; i + 2 < colorFlat.length; i += 3)
    stageColors.push([colorFlat[i], colorFlat[i + 1], colorFlat[i + 2]]);
  return {
    dpiGradeDefaults: grade,
    dpiStageColors: stageColors,
    dpiMaxGrade: num('DPIMaxGrade')[0] ?? 6,
    keyNumber: num('KeyNumber')[0] ?? 6,
    batteryCurve: num('BatteryParam'),
  };
}

function writeMouseOptionsTs(outDir, opts, ini) {
  const j = (v) => JSON.stringify(v);
  const ts =
    `// AUTO-EXTRACTED from the vendor Mouse Hub (Language/en.json + usersetting/Config.ini).\n` +
    `// Do not edit. Regenerate: npm run extract\n` +
    `// Provenance: ported-from-vendor — these are the option sets and wire values\n` +
    `// the vendor software itself uses; confirm against a capture before trusting a write.\n` +
    `// Lives in shared/ (pure data, no Node) so the renderer can label controls with it.\n\n` +
    `import type { LodOption } from './types';\n\n` +
    `/** Lift-off distance: {wire value written to the device, mm label}. */\n` +
    `export const LOD_OPTIONS: LodOption[] = ${j(opts.lod)};\n\n` +
    `/** Polling rate: Hz <-> the bitmask value the device expects (NOT a list index). */\n` +
    `export const POLL_RATE_WIRE: { hz: number; wire: number }[] = ${j(opts.pollRates)};\n` +
    `export const pollRateToWire = (hz: number): number =>\n` +
    `  POLL_RATE_WIRE.find((r) => r.hz === hz)?.wire ?? POLL_RATE_WIRE[POLL_RATE_WIRE.length - 1]!.wire;\n` +
    `export const pollRateFromWire = (wire: number): number =>\n` +
    `  POLL_RATE_WIRE.find((r) => r.wire === wire)?.hz ?? 1000;\n\n` +
    `export const SENSOR_MODES: { value: number; label: string }[] = ${j(opts.sensorModes)};\n` +
    `export const PERFORMANCE_TIMEOUTS: { value: number; label: string }[] = ${j(opts.performanceTimeouts)};\n` +
    `export const DPI_LED_EFFECTS: { value: number; label: string }[] = ${j(opts.dpiLedEffects)};\n` +
    `export const LIGHT_MODES: { value: number; label: string }[] = ${j(opts.lightModes)};\n` +
    `export const LIGHT_OFF_TIMEOUTS: { value: number; label: string }[] = ${j(opts.lightOffTimeouts)};\n` +
    `export const RECEIVER_LED_INDICATION: { value: number; label: string }[] = ${j(opts.receiverIndication)};\n` +
    `export const BUTTON_ACTIONS: { value: string; label: string }[] = ${j(opts.buttonActions)};\n` +
    `/** Full KeyOptions with the vendor's translated sub-action trees — see shared/mouse-buttons.ts. */\n` +
    `export const BUTTON_ACTION_TREE: { value: string; label: string; children: { value: string; label: string }[] }[] = ${j(opts.buttonActionTree)};\n` +
    `export const DPI_DYNAMIC_MODE_LABELS: { value: number; label: string }[] = ${j(opts.dpiDynamicModes)};\n\n` +
    `/** V8 [Drive1] defaults. */\n` +
    `export const DPI_GRADE_DEFAULTS: number[] = ${j(ini.dpiGradeDefaults)};\n` +
    `export const DPI_STAGE_COLORS: [number, number, number][] = ${j(ini.dpiStageColors)};\n` +
    `export const DPI_MAX_GRADE = ${ini.dpiMaxGrade};\n` +
    `export const KEY_NUMBER = ${ini.keyNumber};\n` +
    `export const BATTERY_CURVE: number[] = ${j(ini.batteryCurve)};\n` +
    `\n// NOTE: batteryPercentFromCurve() lives in ./battery.ts — it is NOT part of\n` +
    `// this generated file and must not be added here.\n`;
  fs.writeFileSync(path.join(outDir, 'mouse-options.ts'), ts);
}

function dumpVendorLangs(hubDir, rawDir) {
  const src = path.join(hubDir, 'Language');
  const dst = path.join(rawDir, 'vendor-lang');
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}

try {
  const kbJs = readAllJs(KB_APP);
  const devices = extractDevices(kbJs);
  const cmds = extractCmds(KB_APP);
  const header = fs.readFileSync(path.join(HUB_APP, 'driver_sensor.h'), 'utf8');
  const sensors = extractSensors(header);
  const mouseOpts = extractMouseOptions(HUB_APP);
  const mouseIni = extractMouseConfigIni(HUB_APP);

  fs.writeFileSync(path.join(rawDir, 'devices.json'), JSON.stringify(devices, null, 1));
  fs.writeFileSync(path.join(rawDir, 'fea_cmd.json'), JSON.stringify(cmds, null, 1));
  fs.writeFileSync(path.join(rawDir, 'sensors.json'), JSON.stringify(sensors, null, 1));
  fs.writeFileSync(
    path.join(rawDir, 'mouse_options.json'),
    JSON.stringify({ ...mouseOpts, ...mouseIni }, null, 1),
  );
  writeMouseOptionsTs(path.resolve('src/shared'), mouseOpts, mouseIni);
  dumpVendorLangs(HUB_APP, rawDir);

  const compxCfg = devices.filter((r) => r.vid === 0x3151 && r.usage_page === 0xffff);
  const rr = {};
  for (const r of devices) if (r.reportRate) rr[r.pid] = r.reportRate;

  const pidsTs =
    `// AUTO-EXTRACTED — do not edit. Regenerate: npm run extract\n\n` +
    `export const COMPX_VENDOR_CONFIG_PIDS: number[] = [\n  ${compxCfg.map((r) => '0x' + r.pid.toString(16)).join(', ')},\n];\n\n` +
    `export const COMPX_KEYBOARD_HID_PIDS: number[] = [\n  ${devices
      .filter((r) => r.vid === 0x3151 && r.usage_page === 1)
      .map((r) => '0x' + r.pid.toString(16))
      .join(', ')},\n];\n\n` +
    `export const REPORT_RATE_HINT: Record<number, number> = {\n${Object.entries(rr)
      .map(([p, v]) => `  0x${(+p).toString(16)}: ${v},`)
      .join('\n')}\n};\n`;
  fs.writeFileSync(path.join(outDir, 'catalog', 'known-pids.ts'), pidsTs);

  const dpiTs =
    `// AUTO-EXTRACTED from driver_sensor.h — DPI -> sensor register byte. Regenerate: npm run extract\n\n` +
    `export const DPI_REGISTER_TABLES: Record<string, Record<number, number>> = {\n` +
    Object.entries(sensors)
      .map(
        ([k, v]) =>
          `  "${k}": { ${Object.entries(v)
            .map(([d, r]) => `${d}:${r}`)
            .join(', ')} },`,
      )
      .join('\n') +
    `\n};\n`;
  fs.writeFileSync(path.join(outDir, 'dpi-tables.ts'), dpiTs);

  console.log(`devices: ${devices.length}  compx-config: ${compxCfg.length}`);
  console.log(`cmd sets: ${Object.keys(cmds).join(', ')}`);
  console.log(`sensor tables: ${Object.keys(sensors).join(', ')}`);
  console.log(
    `mouse options: lod=${mouseOpts.lod.length} pollRates=${mouseOpts.pollRates.length} ` +
      `receiverModes=${mouseOpts.receiverIndication.length} dpiColors=${mouseIni.dpiStageColors.length}`,
  );
} catch (e) {
  console.error('extraction failed:', e.message);
  console.error('Set ASHARK_KB_APP / ASHARK_HUB_APP to the installed vendor app paths.');
  process.exit(1);
}
