// Shared recorder for the README tours: the app (served by vite.tours.config.mjs
// on :5181, desktop look, demo devices) in an offscreen Electron window, a
// virtual clock (tours-preload.js), one 1600x1000 PNG per 1/15 s.
//
//   electron <story>.cjs <outDir> [--frames=N] [--probe] [--dbg]
//
// A story module calls run(story). The story gives a timeline of cursor moves,
// clicks, drags, scrolls and page actions in ms; see tour1.cjs / tour2.cjs.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
// The app folder, as Vite's /@fs/ URLs name it (tour-page.js imports the app's own store).
const APP_FS = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
const URL = 'http://127.0.0.1:5181/#demo';
const W = 1280;
const H = 800;
const DSF = 1.25;
const FPS = 15;
const FRAME_MS = 1000 / FPS;
const V8 = '3554:f517:sim-attack-shark-v8';
const R85 = '3151:5029:sim-attack-shark-r85he';

app.commandLine.appendSwitch('force-device-scale-factor', String(DSF));
app.commandLine.appendSwitch('lang', 'en-US');
app.commandLine.appendSwitch('disable-threaded-animation');
app.commandLine.appendSwitch('disable-threaded-scrolling');
app.commandLine.appendSwitch('disable-checker-imaging');
app.on('window-all-closed', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EASE = {
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  linear: (x) => x,
  smooth: (x) => x * x * (3 - 2 * x),
  out: (x) => 1 - Math.pow(1 - x, 3),
};

function parseArgs() {
  const argv = process.argv.slice(2);
  const pos = argv.filter((a) => !a.startsWith('--'));
  const opt = Object.fromEntries(
    argv
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const [k, v] = a.slice(2).split('=');
        return [k, v ?? '1'];
      }),
  );
  return { outDir: pos[0], opt };
}

async function openSession() {
  const partition = 'tours-' + process.pid + '-' + Date.now();
  const ses = session.fromPartition(partition);
  ses.setDevicePermissionHandler(() => false);
  ses.setPermissionCheckHandler((_wc, permission) => permission !== 'hid');
  const win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      partition,
      preload: path.join(HERE, 'tours-preload.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
    },
  });
  win.setContentSize(W, H);
  win.webContents.setFrameRate(60);
  const s = { win, paints: 0, lastImg: null, consoleLog: [] };
  win.webContents.on('paint', (_e, _dirty, img) => {
    s.paints++;
    s.lastImg = img;
  });
  win.webContents.on('console-message', (e) => {
    const msg = e.message ?? '';
    const level = e.level ?? '';
    if (
      /error|warn/i.test(String(level)) &&
      !/React DevTools|frame-ancestors|vite|ws:\/\//i.test(msg)
    ) {
      s.consoleLog.push(`[${level}] ${msg.slice(0, 400)}`);
    }
  });
  await win.loadURL(URL);
  win.webContents.setZoomFactor(1);
  s.js = async (code) => {
    const r = await win.webContents.executeJavaScript(
      `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { err: String((e && e.stack) || e) }; } })()`,
    );
    if (r && r.err) throw new Error('page: ' + r.err);
    return r;
  };
  s.grab = async (n = 2) => {
    for (let i = 0; i < n; i++) {
      const p = s.paints;
      win.webContents.invalidate();
      for (let j = 0; s.paints === p && j < 400; j++) await sleep(5);
    }
    return s.lastImg;
  };
  s.mouse = (type, x, y, extra = {}) =>
    win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), ...extra });
  s.resolve = (spec) => s.js(`return window.__tour.resolve(${JSON.stringify(spec)})`);
  return s;
}

async function setupApp(s, story) {
  for (let i = 0; ; i++) {
    const n = await s.js(`return document.querySelectorAll('.grid .card').length`);
    if (n === 2) break;
    if (i > 100) throw new Error('devices did not appear: ' + n);
    await sleep(200);
  }
  await s.win.webContents.executeJavaScript(
    fs.readFileSync(path.join(HERE, 'tour-page.js'), 'utf8').split('__APP__').join(APP_FS),
  );
  await s.js(
    `return await window.__tour.setup(${JSON.stringify({
      profiles: story.profiles || [],
      switcher: {
        running: true,
        suspended: false,
        activeProfileId: null,
        current: {
          profileId: 'desktop',
          profileName: 'Desktop',
          isDefault: true,
          pinned: false,
          exe: '',
          exeIcon: null,
        },
      },
      settings: { backgroundAnimate: !!story.bgAnimate, language: 'en' },
    })})`,
  );
  // The device tabs the old tours had open, then back to Home.
  for (const id of story.tabsBefore || []) {
    await s.js(`return window.__tour.openTab({ name: 'config', deviceId: ${JSON.stringify(id)} })`);
    await sleep(1500);
  }
  await s.js(`return window.__tour.openTab({ name: 'devices' })`);
  await sleep(2500);
  if (story.prepare) await story.prepare(s);
}

/**
 * The recording loop. Timeline entries (ms from frame 0):
 *   { at, dur, to: spec, ease }     cursor move (spec resolved when it starts)
 *   { at, dur, to: spec, drag: true } the same with the button held (down at `at`, up at the end)
 *   { at, click: true }             click where the cursor is
 *   { at, run: 'page js' }          a page action (before the frame's tick)
 *   { at, dur, scroll: { el, to } } smooth scroll of a container (`to`: px, or a spec whose top lands at `offset`)
 * story.zoom: [{ at, dur, rect: [x, y, w, h] (CSS px) | null }] camera, applied when encoding.
 */
async function record(s, story, outDir, opt) {
  const t0 = Date.now();
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });
  let cur = await s.resolve(story.start);
  let lastMouse = [Math.round(cur[0]), Math.round(cur[1])];
  s.mouse('mouseMove', lastMouse[0], lastMouse[1]);
  await sleep(1200);
  await s.js(`return window.__vclock.setManual(true)`);

  const N = Math.round(story.totalMs / FRAME_MS);
  const limit = Math.min(N, +(opt.frames || N));
  const tl = story.timeline.map((e, i) => ({ ...e, i, started: false, done: false }));
  const log = [];
  let held = false;
  // Camera keyframes must not overlap: each starts from where the last ended.
  const zoomTrack = (story.zoom || []).slice().sort((a, b) => a.at - b.at);
  const FULL = [0, 0, W, H];
  const lerpRect = (a, b, e) => a.map((v, j) => v + (b[j] - v) * e);
  function zoomAt(t) {
    let prev = FULL;
    let rect = FULL;
    for (const z of zoomTrack) {
      if (t < z.at) break;
      const to = z.rect || FULL;
      const x = Math.min(1, (t - z.at) / Math.max(1, z.dur || 1));
      rect = lerpRect(prev, to, EASE[z.ease || 'inOut'](x));
      prev = to;
    }
    return rect;
  }

  for (let k = 0; k < limit; k++) {
    const t = k * FRAME_MS;
    const actions = [];
    const fired = [];
    let clicked = false;
    let down = false;
    let up = false;
    for (const e of tl) {
      if (t < e.at) continue;
      if (e.to && !e.started) {
        e.started = true;
        e.from = cur.slice();
        e.dest = await s.resolve(e.to);
        if (e.drag) {
          down = true;
        }
        fired.push(`move->${JSON.stringify(e.to).slice(0, 60)}`);
      }
      if (e.to && e.started && !e.done) {
        const x = Math.min(1, (t - e.at) / Math.max(1, e.dur || 1));
        const ee = EASE[e.ease || 'inOut'](x);
        cur = [e.from[0] + (e.dest[0] - e.from[0]) * ee, e.from[1] + (e.dest[1] - e.from[1]) * ee];
        if (x >= 1) {
          e.done = true;
          if (e.drag) up = true;
        }
      }
      if (e.click && !e.done) {
        e.done = true;
        clicked = true;
        fired.push('click');
      }
      if (e.down && !e.done) {
        e.done = true;
        down = true;
        fired.push('down');
      }
      if (e.up && !e.done) {
        e.done = true;
        up = true;
        fired.push('up');
      }
      if (e.run && !e.done) {
        e.done = true;
        // Run from here, not eval'd in the page: its CSP has no 'unsafe-eval'.
        const rr = await s.js(e.run);
        fired.push('run' + (rr !== undefined ? ':' + JSON.stringify(rr).slice(0, 80) : ''));
      }
      if (e.scroll && !e.done) {
        const x = Math.min(1, (t - e.at) / Math.max(1, e.dur || 1));
        actions.push({
          type: 'scroll',
          el: e.scroll.el,
          to: e.scroll.to,
          offset: e.scroll.offset || 0,
          p: EASE[e.ease || 'inOut'](x),
          key: e.i,
        });
        if (x >= 1) e.done = true;
      }
    }
    const mx = Math.round(cur[0]);
    const my = Math.round(cur[1]);
    if (down) {
      s.mouse('mouseMove', mx, my);
      s.mouse('mouseDown', mx, my, { button: 'left', clickCount: 1 });
      held = true;
    }
    if (!lastMouse || lastMouse[0] !== mx || lastMouse[1] !== my) {
      s.mouse('mouseMove', mx, my, held ? { button: 'left', modifiers: ['leftButtonDown'] } : {});
      lastMouse = [mx, my];
    }
    if (up) {
      s.mouse('mouseUp', mx, my, { button: 'left', clickCount: 1 });
      held = false;
    }
    if (clicked) {
      s.mouse('mouseDown', mx, my, { button: 'left', clickCount: 1 });
      s.mouse('mouseUp', mx, my, { button: 'left', clickCount: 1 });
    }
    await sleep(clicked || down || up ? 80 : 12);
    const r = await s.js(
      `return await window.__tour.frame(${JSON.stringify({ cursor: cur, caption: null, actions, tickMs: k === 0 ? 0 : FRAME_MS, debug: !!opt.dbg })})`,
    );
    // Camera keyframes whose rect is page code are measured when they start.
    for (const z of zoomTrack) {
      if (t >= z.at && z.rectCode && !z.rect) {
        z.rect = await s.js(z.rectCode);
        fired.push('zoom:' + JSON.stringify(z.rect));
      }
    }
    const zoom = zoomAt(t).map((v) => +v.toFixed(2));
    log.push({ k, t: Math.round(t), V: r.V, cursor: cur.map((v) => +v.toFixed(2)), fired, zoom });
    if (opt.dbg) console.log('dbg', k, JSON.stringify(r).slice(0, 600));
    const img = await s.grab();
    fs.writeFileSync(
      path.join(outDir, 'frames', `f${String(k).padStart(4, '0')}.png`),
      img.toPNG(),
    );
    if (k % 30 === 0)
      console.log(
        `frame ${k}/${limit} t=${Math.round(t)} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        fired.join('; '),
      );
  }
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        story: story.name,
        fps: FPS,
        frameMs: FRAME_MS,
        frames: limit,
        size: [W, H],
        dsf: DSF,
        log,
        console: s.consoleLog.slice(0, 200),
      },
      null,
      1,
    ),
  );
  console.log(
    'done',
    limit,
    'frames in',
    ((Date.now() - t0) / 1000).toFixed(1),
    's; console issues:',
    s.consoleLog.length,
  );
  for (const l of s.consoleLog.slice(0, 15)) console.log('  ', l);
}

/** Free-running stills for working out a story: steps of { run?, click?: spec, shot?, wait? }. */
async function probe(s, steps, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  let dumps = 0;
  for (const st of steps) {
    if (st.wait) await sleep(st.wait);
    if (st.run) {
      const r = await s.js(st.run);
      if (typeof r === 'string' && r.length > 200) {
        const f = path.join(outDir, `dump-${String(++dumps).padStart(2, '0')}.txt`);
        fs.writeFileSync(f, r);
        console.log('run ->', f);
      } else console.log('run', JSON.stringify(r).slice(0, 400));
    }
    if (st.click) {
      const p = await s.resolve(st.click);
      s.mouse('mouseMove', p[0], p[1]);
      s.mouse('mouseDown', p[0], p[1], { button: 'left', clickCount: 1 });
      s.mouse('mouseUp', p[0], p[1], { button: 'left', clickCount: 1 });
      await sleep(300);
      s.mouse('mouseMove', W - 3, H - 3);
    }
    if (st.shot) {
      await sleep(st.settle ?? 1500);
      const img = await s.grab(3);
      fs.writeFileSync(
        path.join(outDir, st.shot + '.png'),
        img.resize({ width: 800, height: 500, quality: 'best' }).toPNG(),
      );
      console.log('shot', st.shot);
    }
  }
}

function run(story) {
  const { outDir, opt } = parseArgs();
  app.whenReady().then(async () => {
    try {
      const s = await openSession();
      await setupApp(s, story);
      if (opt.probe) await probe(s, story.probe || [], outDir);
      else await record(s, story, outDir, opt);
    } catch (e) {
      console.log('ERROR', e && e.stack ? e.stack : e);
    }
    app.exit(0);
  });
}

module.exports = { run, V8, R85, W, H, FRAME_MS };
