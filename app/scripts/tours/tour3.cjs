// Records README tour 3 (auto-switch) frame by frame on a virtual clock.
//   electron tour3.cjs <outDir> <anim|still> [--frames=N] [--every=K]
// Captures 1280x800 CSS px at 1.25x (1600x1000 PNGs), one per output frame at
// 15 fps; virtual time advances exactly 1/15 s between frames, so the WebGL
// background, CSS animations, timers and the cursor all move in step.
const { app, BrowserWindow, nativeImage, session } = require('electron');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
// The app folder, as Vite's /@fs/ URLs name it (tour-page.js imports the app's own store).
const APP_FS = path.resolve(HERE, '..', '..').replace(/\\/g, '/');
// The real game, for its real icon: where Steam installs it, or $CS2_EXE.
const CS2 =
  process.env.CS2_EXE ||
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe';
const LOGO_PNG = path.join(HERE, '..', '..', 'assets', 'logo.png');
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
// Deterministic frames: CSS animations run on the main thread (so a pause and
// seek shows in the very next frame, rather than the compositor finishing its
// own real-time copy of a new animation first), and images decode before they
// are drawn (no blank photo for a frame).
app.commandLine.appendSwitch('disable-threaded-animation');
app.commandLine.appendSwitch('disable-threaded-scrolling');
app.commandLine.appendSwitch('disable-checker-imaging');
app.on('window-all-closed', () => {});

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
const outDir = pos[0];
const variant = pos[1] || 'still';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ story
// Times in ms from the first frame, copied from the original tour-3 (its frame
// times, with its merged 134 ms frames counted).
const TOTAL_MS = 24450;
const MOVES = [
  { at: 330, dur: 540, to: 'chevron' },
  { at: 2610, dur: 610, to: 'modes' },
  { at: 4690, dur: 600, to: 'game' },
  { at: 6700, dur: 800, to: 'logo' },
  { at: 8640, dur: 470, to: 'center' },
  { at: 13940, dur: 470, to: 'v8chip' },
  { at: 15210, dur: 540, to: 'r85chip' },
  { at: 17550, dur: 470, to: 'center' },
  { at: 23400, dur: 620, to: 'logo' }, // back where the loop starts
];
const CLICKS = [
  { at: 1130, what: 'chevron (Auto-Switch options)' },
  { at: 7690, what: 'brand (Home)' },
];
const CAPTIONS = [
  { in: 10200, out: 11900, text: 'Counter-Strike 2 starts', tag: 'cs2.exe' },
  { in: 13350, out: 16000, text: 'Mouse and keyboard switch to Gaming', tag: 'Profile 2' },
  { in: 18450, out: 20900, text: 'Game closed', tag: 'cs2.exe' },
  { in: 21400, out: 23650, text: 'Back to Desktop', tag: 'Profile 1' },
];
const FADE_MS = 260;

function buildEvents(icons) {
  const desktopCurrent = {
    profileId: 'desktop',
    profileName: 'Desktop',
    isDefault: true,
    pinned: false,
    exe: '',
    exeIcon: null,
  };
  const gamingCurrent = {
    profileId: 'gaming',
    profileName: 'Gaming',
    isDefault: false,
    pinned: false,
    exe: 'cs2.exe',
    exeIcon: icons.small,
  };
  const card = (kind, mode, exe, exeIcon) => ({
    kind,
    ms: 10000,
    logo: icons.logo,
    brand: 'Shark Deck',
    mode,
    exe,
    exeIcon,
  });
  const devs = (slot) => [
    { id: V8, displayName: 'Attack Shark V8', slot, ok: true },
    { id: R85, displayName: 'Attack Shark R85 HE', slot, ok: true },
  ];
  // The order switcher.ts emits in (tickInner / applyProfileIfChanged).
  return [
    {
      at: 10790,
      label: 'cs2.exe detected: Gaming, applying',
      actions: [
        {
          type: 'switcher',
          patch: { activeProfileId: 'gaming', lastEvent: 'Game detected: Gaming' },
        },
        { type: 'switcher', patch: { current: gamingCurrent } },
        { type: 'switcher', patch: { applying: { profileId: 'gaming', profileName: 'Gaming' } } },
      ],
    },
    { at: 11000, label: 'V8 -> slot 2', actions: [{ type: 'slot', id: V8, slot: 2 }] },
    { at: 11150, label: 'R85HE -> slot 2', actions: [{ type: 'slot', id: R85, slot: 2 }] },
    {
      at: 11390,
      label: 'Gaming applied, switch card',
      actions: [
        { type: 'switcher', patch: { applying: null } },
        {
          type: 'lastSwitch',
          lastEvent: 'Applied "Gaming" (cs2.exe)',
          lastSwitch: {
            profileId: 'gaming',
            profileName: 'Gaming',
            reason: 'game',
            context: 'cs2.exe',
            exeIcon: icons.small,
            devices: devs(2),
          },
        },
        // showSwitchOverlay(): the trigger's own (16 px) icon first ...
        { type: 'overlay', content: card('game', 'Gaming mode', 'cs2.exe', icons.small) },
      ],
    },
    // ... then bigIconFor(pathForRunningExe('cs2.exe')): the 32 px one, same card.
    {
      at: 11990,
      label: 'switch card: 32 px icon',
      actions: [{ type: 'overlay', content: card('game', 'Gaming mode', 'cs2.exe', icons.normal) }],
    },
    {
      at: 19090,
      label: 'cs2.exe exited: Desktop, applying',
      actions: [
        { type: 'switcher', patch: { current: desktopCurrent } },
        { type: 'switcher', patch: { activeProfileId: null, lastEvent: 'Returned to desktop' } },
        { type: 'switcher', patch: { applying: { profileId: 'desktop', profileName: 'Desktop' } } },
      ],
    },
    { at: 19250, label: 'V8 -> slot 1', actions: [{ type: 'slot', id: V8, slot: 1 }] },
    { at: 19400, label: 'R85HE -> slot 1', actions: [{ type: 'slot', id: R85, slot: 1 }] },
    {
      at: 19560,
      label: 'Desktop applied, switch card',
      actions: [
        { type: 'switcher', patch: { applying: null } },
        {
          type: 'lastSwitch',
          lastEvent: 'Applied "Desktop" (cs2.exe)',
          lastSwitch: {
            profileId: 'desktop',
            profileName: 'Desktop',
            reason: 'desktop',
            context: 'cs2.exe',
            exeIcon: icons.small,
            devices: devs(1),
          },
        },
        {
          type: 'overlay',
          content: card('desktop', 'Desktop mode', 'Exited cs2.exe', icons.small),
        },
      ],
    },
  ];
}

function profiles(icons) {
  return [
    {
      id: 'desktop',
      name: 'Desktop',
      builtIn: true,
      isDefault: true,
      icon: { kind: 'builtin', name: 'windows' },
      defaultSlot: 1,
      triggers: [],
      links: {},
    },
    {
      id: 'gaming',
      name: 'Gaming',
      builtIn: true,
      icon: { kind: 'builtin', name: 'gamepad' },
      defaultSlot: 2,
      links: {},
      triggers: [
        { exe: 'r5apex.exe', label: 'Apex Legends', enabled: true, order: 1 },
        // Its icon backfilled the first time it was seen running (switcher.ts
        // backfillTriggerIcons -> iconFor: the 16 px one).
        {
          exe: 'cs2.exe',
          label: 'Counter-Strike 2',
          enabled: true,
          order: 2,
          iconDataUrl: icons.small,
        },
        { exe: 'fortniteclient-win64-shipping.exe', label: 'Fortnite', enabled: false, order: 3 },
        { exe: 'valorant-win64-shipping.exe', label: 'VALORANT', enabled: true, order: 5 },
      ],
    },
    {
      id: 'aim',
      name: 'Aim training',
      icon: { kind: 'builtin', name: 'gamepad' },
      defaultSlot: 3,
      links: { 'attack-shark-v8': { slot: 3 }, 'attack-shark-r85he': { slot: 3 } },
      triggers: [
        { exe: 'aimlab_tb.exe', label: 'Aim Lab', enabled: true, order: 0 },
        { exe: 'fpsaimtrainer-win64-shipping.exe', label: "KovaaK's", enabled: true, order: 4 },
      ],
    },
  ];
}

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const smooth = (x) => x * x * (3 - 2 * x);

function captionAt(t) {
  for (const c of CAPTIONS) {
    if (t < c.in || t > c.out + FADE_MS) continue;
    const a = t < c.in + FADE_MS ? (t - c.in) / FADE_MS : t > c.out ? 1 - (t - c.out) / FADE_MS : 1;
    return { text: c.text, tag: c.tag, alpha: +smooth(Math.max(0, Math.min(1, a))).toFixed(4) };
  }
  return null;
}

// ------------------------------------------------------------------ run
app.whenReady().then(async () => {
  const t0 = Date.now();
  fs.mkdirSync(path.join(outDir, 'frames'), { recursive: true });

  // cs2.exe's icon exactly as main/profiles/processIcons.ts gets it, and the
  // card's logo exactly as main/overlayWindow.ts appLogo() makes it.
  const small = await app.getFileIcon(CS2, { size: 'small' });
  const normal = await app.getFileIcon(CS2, { size: 'normal' });
  const logoImg = nativeImage.createFromPath(LOGO_PNG);
  const icons = {
    small: small.isEmpty() ? null : small.toDataURL(),
    normal: normal.isEmpty() ? null : normal.toDataURL(),
    logo: logoImg.isEmpty() ? '' : logoImg.resize({ width: 72, height: 72 }).toDataURL(),
  };
  if (!icons.small || !icons.normal) throw new Error('no icon for cs2.exe');

  const partition = 'tours-' + process.pid + '-' + Date.now(); // in memory: a fresh profile per run
  const ses = session.fromPartition(partition);
  // Never reach a real device: no WebHID permission for anything.
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
      preload: path.join(HERE, opt.preload || 'tours-preload.js'),
      contextIsolation: false,
      sandbox: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
    },
  });
  win.setContentSize(W, H);
  win.webContents.setFrameRate(60);
  let paints = 0;
  let lastImg = null;
  win.webContents.on('paint', (_e, _dirty, img) => {
    paints++;
    lastImg = img;
  });
  const consoleLog = [];
  win.webContents.on('console-message', (e) => {
    const msg = e.message ?? '';
    const level = e.level ?? '';
    if (
      /error|warn/i.test(String(level)) &&
      !/React DevTools|frame-ancestors|vite|ws:\/\//i.test(msg)
    ) {
      consoleLog.push(`[${level}] ${msg.slice(0, 400)}`);
    }
  });

  await win.loadURL(URL);
  win.webContents.setZoomFactor(1);
  const js = async (code) => {
    const r = await win.webContents.executeJavaScript(
      `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { err: String((e && e.stack) || e) }; } })()`,
    );
    if (r && r.err) throw new Error('page: ' + r.err);
    return r;
  };

  // Wait for the two devices of the tour.
  for (let i = 0; ; i++) {
    const n = await js(`return document.querySelectorAll('.grid .card').length`);
    if (n === 2) break;
    if (i > 100) throw new Error('devices did not appear: ' + n);
    await sleep(200);
  }
  await win.webContents.executeJavaScript(
    fs.readFileSync(path.join(HERE, 'tour-page.js'), 'utf8').split('__APP__').join(APP_FS),
  );
  const setup = await js(
    `return await window.__tour.setup(${JSON.stringify({
      profiles: profiles(icons),
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
      // Still until the recording starts, for both variants: the moving one then
      // starts from the same frame the still one keeps.
      settings: { backgroundAnimate: false, language: 'en' },
    })})`,
  );
  console.log(
    'setup',
    JSON.stringify({ devices: setup.devices, tabs: setup.tabs, overlaySubs: setup.overlaySubs }),
  );

  // The device tabs the original tour had open, then back to Home.
  await js(`return window.__tour.openTab({ name: 'config', deviceId: ${JSON.stringify(V8)} })`);
  await sleep(1500);
  await js(`return window.__tour.openTab({ name: 'config', deviceId: ${JSON.stringify(R85)} })`);
  await sleep(1500);
  await js(`return window.__tour.openTab({ name: 'devices' })`);
  await sleep(3000);
  const ready = await js(`return window.__tour.state()`);
  console.log(
    'ready',
    JSON.stringify({
      devices: ready.devices,
      tabs: ready.tabs,
      active: ready.active,
      sw: ready.switcher && ready.switcher.running,
      clock: ready.clock,
    }),
  );

  // The pointer rests on the brand before the first frame, as it does at the
  // end of the loop, so the brand's hover is already on in frame 0.
  let cur = await js(`return window.__tour.target('logo')`);
  let lastMouse = [Math.round(cur[0]), Math.round(cur[1])];
  win.webContents.sendInputEvent({ type: 'mouseMove', x: lastMouse[0], y: lastMouse[1] });
  await sleep(1200);

  // ---------------------------------------------------------------- record
  await js(`return window.__vclock.setManual(true)`);
  const events = buildEvents(icons);
  const N = Math.round(TOTAL_MS / FRAME_MS); // 367
  const limit = Math.min(N, +(opt.frames || N));
  const every = +(opt.every || 1);
  const moves = MOVES.map((m) => ({ ...m, from: null, dest: null }));
  const clicks = CLICKS.map((c) => ({ ...c, done: false }));
  const evs = events.map((e) => ({ ...e, done: false }));
  const log = [];
  let animOn = false;

  const PAINTS = +(opt.paints || 2);
  async function grab() {
    for (let n = 0; n < PAINTS; n++) {
      const p = paints;
      win.webContents.invalidate();
      for (let i = 0; paints === p && i < 200; i++) await sleep(5);
    }
    return lastImg;
  }

  for (let k = 0; k < limit; k++) {
    const t = k * FRAME_MS;
    // cursor
    for (const m of moves) {
      if (t >= m.at && !m.dest) {
        m.from = cur.slice();
        m.dest = await js(`return window.__tour.target(${JSON.stringify(m.to)})`);
      }
      if (m.dest && t >= m.at) {
        const x = Math.min(1, (t - m.at) / m.dur);
        const e = ease(x);
        cur = [m.from[0] + (m.dest[0] - m.from[0]) * e, m.from[1] + (m.dest[1] - m.from[1]) * e];
      }
    }
    const mx = Math.round(cur[0]);
    const my = Math.round(cur[1]);
    if (!lastMouse || lastMouse[0] !== mx || lastMouse[1] !== my) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: mx, y: my });
      lastMouse = [mx, my];
    }
    let clicked = null;
    for (const c of clicks) {
      if (!c.done && t >= c.at) {
        c.done = true;
        clicked = c.what;
        win.webContents.sendInputEvent({
          type: 'mouseDown',
          x: mx,
          y: my,
          button: 'left',
          clickCount: 1,
        });
        win.webContents.sendInputEvent({
          type: 'mouseUp',
          x: mx,
          y: my,
          button: 'left',
          clickCount: 1,
        });
      }
    }
    await sleep(clicked ? 80 : 12);
    const actions = [];
    if (k === 0 && variant === 'anim' && !animOn) {
      actions.push({ type: 'settings', patch: { backgroundAnimate: true } });
      animOn = true;
    }
    const fired = [];
    for (const e of evs) {
      if (!e.done && t >= e.at) {
        e.done = true;
        actions.push(...e.actions);
        fired.push(e.label);
      }
    }
    const caption = captionAt(t);
    const r = await js(
      `return await window.__tour.frame(${JSON.stringify({ cursor: cur, caption, actions, tickMs: k === 0 ? 0 : FRAME_MS, debug: !!opt.dbg })})`,
    );
    if (opt.dbg)
      console.log(
        'dbg',
        k,
        JSON.stringify({ view: r.view, scroll: r.scroll, anims: r.anims }).slice(0, 900),
      );
    log.push({
      k,
      t: Math.round(t),
      V: r.V,
      cursor: cur.map((v) => +v.toFixed(2)),
      caption: caption && caption.alpha ? `${caption.text} (${caption.alpha})` : null,
      clicked,
      fired,
    });
    if (k % every === 0) {
      const img = await grab();
      fs.writeFileSync(
        path.join(outDir, 'frames', `f${String(k).padStart(4, '0')}.png`),
        img.toPNG(),
      );
    }
    if (k % 30 === 0)
      console.log(
        `frame ${k}/${limit} t=${Math.round(t)} ${((Date.now() - t0) / 1000).toFixed(1)}s`,
        fired.join('; '),
      );
  }
  const end = await js(`return window.__tour.state()`);
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
      {
        variant,
        fps: FPS,
        frameMs: FRAME_MS,
        frames: limit,
        size: [W, H],
        dsf: DSF,
        log,
        end: { devices: end.devices, tabs: end.tabs, clock: end.clock },
        console: consoleLog.slice(0, 200),
      },
      null,
      1,
    ),
  );
  fs.writeFileSync(path.join(outDir, 'icons.json'), JSON.stringify(icons));
  console.log(
    'done',
    limit,
    'frames in',
    ((Date.now() - t0) / 1000).toFixed(1),
    's; console issues:',
    consoleLog.length,
  );
  for (const l of consoleLog.slice(0, 15)) console.log('  ', l);
  app.exit(0);
});
