/**
 * Capture the R85HE protocol the way Driver v4 actually talks to it: **WebHID
 * in the Electron renderer** (`HIDDevice.sendFeatureReport` /
 * `receiveFeatureReport` / `sendReport` + `inputreport` events). The gRPC ->
 * iot_driver path this project assumed is used for other devices, not this
 * keyboard — hooking iot_driver saw nothing.
 *
 * How: relaunch Driver v4 with `--remote-debugging-port`, attach over the
 * Chrome DevTools Protocol (Node 24 has global fetch + WebSocket, no deps),
 * monkey-patch the three WebHID methods in the renderer so every call is
 * logged, then walk the same step list as capture-kb.py.
 *
 *   node webhid-capture.mjs                 # relaunch Driver v4 + capture
 *   node webhid-capture.mjs --attach        # don't relaunch; port already open
 *   node webhid-capture.mjs --port 9333
 *
 * Output: session-r85he-webhid.jsonl (one JSON record per WebHID call, tagged
 * with the current step).
 */
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'session-r85he-webhid.jsonl');

const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf('--port') + 1]) || 9222;
const ATTACH_ONLY = argv.includes('--attach');

const DRIVER_EXE =
  process.env.ASHARK_DRIVER_EXE ||
  `C:/Users/${process.env.USERNAME || 'me'}/AppData/Local/Programs/Attack Shark Driver v4/Attack Shark Driver v4.exe`;

// keep in sync with capture-kb.py STEPS
const STEPS = [
  ['01_enumerate', 'Driver v4 open, R85HE card shown. Enter.'],
  ['02_read_all_pages', 'Open every settings page/tab once, change NOTHING. Enter when done.'],
  ['04_poll_125', 'Polling rate: 125 Hz. Enter.'],
  ['04_poll_250', 'Polling rate: 250 Hz. Enter.'],
  ['04_poll_500', 'Polling rate: 500 Hz. Enter.'],
  ['04_poll_1000', 'Polling rate: 1000 Hz. Enter.'],
  ['04_poll_2000', 'Polling rate: 2000 Hz. Enter.'],
  ['04_poll_4000', 'Polling rate: 4000 Hz. Enter.'],
  ['04_poll_8000', 'Polling rate: 8000 Hz. Enter.'],
  ['05_profile_1', 'Profile / layer slot 1. Enter.'],
  ['05_profile_2', 'Profile slot 2. Enter.'],
  ['05_profile_3', 'Profile slot 3. Enter.'],
  ['05_profile_4', 'Profile slot 4. Enter.'],
  ['06_actuation_min', 'Global actuation: lowest (~0.1 mm). Enter.'],
  ['06_actuation_mid', 'Global actuation: ~1.5 mm. Enter.'],
  ['06_actuation_max', 'Global actuation: highest (~3.0 mm). Enter.'],
  ['07_key_esc', 'Per-key actuation: ESC only, ~0.5 mm. Enter.'],
  ['07_key_q', 'Per-key actuation: Q only, ~2.0 mm. Enter.'],
  ['07_key_right', 'Per-key actuation: RIGHT ARROW only, ~2.99 mm. Enter.'],
  ['08_rt_pair', 'Rapid trigger: enable it on the SPACE + B pair (RT needs a pair). Enter.'],
  ['08_rt_off', 'Turn that rapid-trigger pair back OFF. Enter.'],
  ['10_deadzone_top', 'Top dead zone (a SEPARATE control from rapid trigger): set ~0.4 mm on ESC. Enter.'],
  ['10_deadzone_bottom', 'Bottom dead zone on ESC: set ~0.4 mm, then back to ~0.3 mm. Enter.'],
  ['09_dks', 'DKS mode on A: fill the 4 action keys A/B/C/D; points A-press 0.7, B-press 3.2, C-release 3.2, D-release 0.7. Enter.'],
  ['09_mt', 'Mod-tap on one key, hold-trigger 200 ms. Enter (skip if not offered).'],
  ['09_tgl', 'Toggle / long-press on key D -> key D. Enter (skip if not offered).'],
  ['10_calibrate', 'Magnetic calibration / recalibrate button, if present. Else Enter.'],
  ['11_remap_key', 'Remap a spare key (e.g. Right-Ctrl) to F12. Enter.'],
  ['11_fn_layer', 'Fn-layer: remap one key on the Fn layer. Enter.'],
  ['11_layer_2', 'Layer 2: remap one key (skip if no layer switch). Enter.'],
  ['12_macro', 'Record a 2-key macro with a delay, assign it to a key. Enter.'],
  ['13_perkey_colour', 'PER-KEY lighting (static colour is the only per-key option): set 3-4 different keys to different solid colours. Enter when done.'],
  ['13_global_light', 'GLOBAL / whole-board lighting: step through a few effects, then brightness + speed + direction. Enter when done.'],
  ['14_side_light', 'Side / edge lighting: each effect. Enter when done.'],
  ['17_restore', 'Restore Defaults / factory reset, if present. Else Enter.'],
  ['18_live_travel', 'Live per-key travel / monitor view, press keys, close. Enter.'],
  ['19_firmware', 'Open the firmware page. DO NOT start an update. Enter.'],
  ['99_done', 'Done — Enter to stop and write the file.'],
];

// --- the renderer-side patch -------------------------------------------------
// Wrap the three WebHID methods + inputreport. Emits console lines the CDP
// client picks up via Runtime.consoleAPICalled. Idempotent.
// Emits via the CDP binding window.__hidcap (added with Runtime.addBinding) —
// robust against the renderer overriding console. Falls back to console if the
// binding isn't there. Patches HIDDevice.prototype; also wraps HID.prototype
// (the collection object) in case the app calls through that.
const PATCH = `(() => {
  const emit = (o) => {
    try { window.__hidcap(JSON.stringify(o)); }
    catch (e) { try { console.log('__HIDCAP__' + JSON.stringify(o)); } catch (e2) {} }
  };
  const hex = (v) => {
    const u = v instanceof ArrayBuffer ? new Uint8Array(v)
      : v && v.buffer ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      : v instanceof Uint8Array ? v : new Uint8Array(v || []);
    return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join(' ');
  };
  const wrapProto = (P, label) => {
    if (!P || P.__hidcapWrapped) return false;
    P.__hidcapWrapped = true;
    const wrap = (name, dir) => {
      const orig = P[name];
      if (typeof orig !== 'function') return;
      P[name] = async function (reportId, data) {
        const info = { tag: name, dir, on: label, reportId,
          product: this.productName, vid: this.vendorId, pid: this.productId };
        if (data !== undefined) info.hex = hex(data);
        try {
          const r = await orig.apply(this, arguments);
          if ((name === 'receiveFeatureReport' || name === 'getFeature') && r) info.hex = hex(r);
          emit(info);
          return r;
        } catch (e) { info.error = String(e); emit(info); throw e; }
      };
    };
    ['sendReport', 'sendFeatureReport', 'receiveFeatureReport',
     'setFeature', 'getFeature'].forEach((n) => wrap(n, n.toLowerCase().indexOf('send') === 0 || n === 'setFeature' ? 'set' : 'get'));
    const addEL = P.addEventListener;
    if (typeof addEL === 'function') {
      P.addEventListener = function (type, cb, ...rest) {
        if (type === 'inputreport' && typeof cb === 'function') {
          return addEL.call(this, type, (ev) => {
            emit({ tag: 'inputreport', dir: 'in', on: label, reportId: ev.reportId,
              product: this.productName, hex: hex(ev.data) });
            return cb.call(this, ev);
          }, ...rest);
        }
        return addEL.call(this, type, cb, ...rest);
      };
    }
    return true;
  };

  const wrapped = [];
  if (typeof HIDDevice !== 'undefined') wrapProto(HIDDevice.prototype, 'HIDDevice') && wrapped.push('HIDDevice');
  if (typeof HID !== 'undefined') wrapProto(HID.prototype, 'HID') && wrapped.push('HID');

  // proof-of-life: what does the renderer actually have?
  Promise.resolve(navigator.hid && navigator.hid.getDevices ? navigator.hid.getDevices() : [])
    .then((ds) => emit({ tag: '__installed__', wrapped,
      devices: ds.map((d) => ({ name: d.productName, vid: d.vendorId, pid: d.productId, opened: d.opened })) }))
    .catch((e) => emit({ tag: '__installed__', wrapped, devicesError: String(e) }));

  return 'patched:' + wrapped.join(',');
})()`;

// --- CDP plumbing ----------------------------------------------------------
const records = [];
let currentStep = '00_preamble';
let msgId = 0;
const pending = new Map();

function cdpSend(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function waitForTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json`).then((r) => r.json());
      const page = list.find(
        (t) => t.type === 'page' && /index\.html|localhost/.test(t.url || ''),
      );
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no debuggable renderer on :${PORT} after 30 s`);
}

function relaunch() {
  console.log('[*] closing any running Driver v4 …');
  try {
    execSync('taskkill /f /im "Attack Shark Driver v4.exe" /t', { stdio: 'ignore' });
  } catch {
    /* not running */
  }
  if (!fs.existsSync(DRIVER_EXE)) {
    console.error(`[!] Driver v4 exe not found: ${DRIVER_EXE}\n    set ASHARK_DRIVER_EXE`);
    process.exit(1);
  }
  console.log(`[*] launching with --remote-debugging-port=${PORT}`);
  const child = spawn(DRIVER_EXE, [`--remote-debugging-port=${PORT}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

async function main() {
  if (!ATTACH_ONLY) relaunch();

  console.log('[*] waiting for the renderer …');
  const page = await waitForTarget();
  console.log(`[*] attached: ${page.title || page.url}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  function ingest(s) {
    let rec;
    try {
      rec = JSON.parse(s);
    } catch {
      return;
    }
    rec.t = Date.now();
    rec.step = currentStep;
    if (rec.tag === '__installed__') {
      const list = (rec.devices || [])
        .map((d) => `${d.name} ${d.vid?.toString(16)}:${d.pid?.toString(16)}${d.opened ? ' [open]' : ''}`)
        .join(' | ');
      console.log(`[*] patch live on ${rec.wrapped?.join('+') || '?'}; renderer devices: ${list || rec.devicesError || '(none)'}`);
      if (!/5029/.test(list)) {
        console.log(
          '\x1b[33m[!] The R85HE (…:5029) is not in this renderer yet — power-cycle the\n' +
            "    keyboard / use the app's pair button. The patch stays live.\x1b[0m",
        );
      }
      records.push(rec);
      return;
    }
    records.push(rec);
    const kb = rec.pid === 0x5029 || /r85he/i.test(rec.product || '');
    console.log(
      `    \x1b[36m[${currentStep}]\x1b[0m ${rec.tag}/${rec.dir} on=${rec.on} id=${rec.reportId}` +
        (kb ? '' : `  (${rec.product || 'other'})`),
    );
    if (rec.hex) console.log(`       ${rec.hex}`);
  }

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === '__hidcap') {
      ingest(m.params.payload);
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const arg = m.params.args && m.params.args[0];
      const s = arg && typeof arg.value === 'string' ? arg.value : '';
      if (s.startsWith('__HIDCAP__')) ingest(s.slice('__HIDCAP__'.length));
    } else if (m.method === 'Runtime.executionContextsCleared' || m.method === 'Page.frameNavigated') {
      // renderer reloaded — re-inject (addScriptToEvaluateOnNewDocument also
      // covers this, but re-evaluate immediately in case timing raced)
      cdpSend(ws, 'Runtime.evaluate', { expression: PATCH, returnByValue: true }).catch(() => {});
    }
  });

  await cdpSend(ws, 'Runtime.enable');
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.addBinding', { name: '__hidcap' });
  await cdpSend(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: PATCH });
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression: PATCH, returnByValue: true });
  console.log(`[*] renderer patch: ${r.result?.value}`);
  if (r.exceptionDetails) {
    console.log('\x1b[31m[!] patch threw:\x1b[0m', JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  // Wait for the renderer to actually have the R85HE before starting. On a
  // relaunch the WebHID grant may need the app's connect flow to run (and the
  // keyboard must be healthy — power-cycle it if the keys are dead).
  const devQuery =
    `navigator.hid.getDevices().then(ds=>ds.map(d=>d.vendorId.toString(16)+':'+d.productId.toString(16)).join(','))`;
  let armed = false;
  for (let i = 0; i < 40; i++) {
    const dq = await cdpSend(ws, 'Runtime.evaluate', {
      expression: devQuery,
      awaitPromise: true,
      returnByValue: true,
    }).catch(() => null);
    const list = dq?.result?.value || '';
    if (/5029/.test(list)) {
      console.log(`\x1b[32m[*] R85HE is connected in the renderer (${list}).\x1b[0m`);
      armed = true;
      break;
    }
    if (i === 0) {
      console.log(
        '\x1b[33m[*] Renderer has no R85HE yet. In the Driver v4 window: power-cycle the\n' +
          "    keyboard, wait for its card, click 'connect'/'+'/allow the device picker if\n" +
          '    the app shows one. Polling for 2 min…\x1b[0m',
      );
    } else if (i % 4 === 0) {
      process.stdout.write(`    …still waiting (${list || 'no HID devices'})\n`);
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  if (!armed) {
    const go = await ask(
      '\x1b[33m[!] R85HE still not visible to the renderer after 2 min.\n' +
        '    Start anyway? Frames will only be caught once it connects. [y/N] \x1b[0m',
    );
    if (!/^y/i.test(go.trim())) {
      rl.close();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      process.exit(1);
    }
  }

  console.log(`\n[*] ${STEPS.length} steps. Cyan lines are WebHID calls.\n`);
  let noiseBefore = records.length;
  for (let i = 0; i < STEPS.length; i++) {
    const [name, desc] = STEPS[i];
    currentStep = name;
    const bar = '═'.repeat(74);
    const seen = records.length - noiseBefore;
    await ask(
      `\n\x1b[1m${bar}\n STEP ${i + 1}/${STEPS.length}  —  ${name}\n${bar}\x1b[0m\n ${desc}\n` +
        `\x1b[33m Do it in Driver v4, then press Enter.\x1b[0m` +
        (seen ? `   (${seen} WebHID calls recorded on the previous step)` : '') +
        `\n > `,
    );
    noiseBefore = records.length;
  }
  rl.close();

  fs.writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const kb = records.filter((r) => r.pid === 0x5029 || /r85he/i.test(r.product || ''));
  console.log(`\n[*] ${records.length} WebHID calls (${kb.length} to the R85HE) -> ${OUT}`);
  const byStep = {};
  for (const r of kb) (byStep[r.step] ||= []).push(`${r.tag}/${r.dir}`);
  for (const [s, list] of Object.entries(byStep)) console.log(`   ${s}: ${list.length}  (${[...new Set(list)].join(', ')})`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
