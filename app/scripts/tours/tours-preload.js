/* Page-world preload for the tour recorder (contextIsolation off, so this runs
 * in the page's own JS world before any of its scripts). Three jobs:
 *
 *  1. In the overlay.html frame: `window.overlay`, the shim for preload/overlay.ts,
 *     so the real overlay page can be driven from the parent page.
 *  2. In the app page: a virtual clock. setTimeout/setInterval, rAF,
 *     performance.now and Date.now all run on time the recorder advances, one
 *     output frame at a time; CSS/Web Animations are paused and seeked to it.
 *     Before recording, a pump keeps it in step with real time.
 *  3. In the app page: the `window.sharkdeck` the browser edition installs is
 *     patched as the desktop host would answer: auto-switch profiles and state,
 *     Windows platform info, and only the two devices of the tour.
 *
 * Nothing here is part of the app; it only stands in for the desktop host.
 */
(function () {
  'use strict';
  const path = location.pathname || '';

  // ---------------------------------------------------------------- overlay
  if (/overlay\.html$/.test(path)) {
    const subs = { content: new Set(), pointer: new Set(), fade: new Set() };
    window.overlay = {
      onContent(cb) {
        subs.content.add(cb);
        return () => subs.content.delete(cb);
      },
      onPointer(cb) {
        subs.pointer.add(cb);
        return () => subs.pointer.delete(cb);
      },
      onFade(cb) {
        subs.fade.add(cb);
        return () => subs.fade.delete(cb);
      },
    };
    window.__overlaySend = (ch, payload) => {
      for (const cb of subs[ch]) cb(payload);
      return subs[ch].size;
    };
    return;
  }
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

  // ---------------------------------------------------------- virtual clock
  const R = {
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    now: performance.now.bind(performance),
    dateNow: Date.now.bind(Date),
  };
  window.__R = R;
  const T0 = R.now();
  const D0 = R.dateNow();
  let V = T0;
  let manual = false;
  let seq = 1;
  const timers = new Map();
  let rafQ = new Map();
  let rafSeq = 1;
  let firedTimers = 0;
  let firedRafs = 0;

  function addTimer(cb, ms, args, repeat) {
    const id = seq++;
    const d = Math.max(0, Number(ms) || 0);
    const interval = repeat ? Math.max(1, d) : 0;
    timers.set(id, { id, cb, args, due: V + (repeat ? interval : d), interval, order: id });
    return id;
  }
  window.setTimeout = function (cb, ms, ...args) {
    return addTimer(cb, ms, args, false);
  };
  window.setInterval = function (cb, ms, ...args) {
    return addTimer(cb, ms, args, true);
  };
  window.clearTimeout = function (id) {
    timers.delete(id);
  };
  window.clearInterval = function (id) {
    timers.delete(id);
  };
  window.requestAnimationFrame = function (cb) {
    const id = rafSeq++;
    rafQ.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    rafQ.delete(id);
  };
  performance.now = function () {
    return V;
  };
  Date.now = function () {
    return Math.round(D0 + (V - T0));
  };

  // A macrotask: every microtask queued so far (promise chains) runs before it.
  const mc = new MessageChannel();
  const waiters = [];
  mc.port1.onmessage = () => {
    const w = waiters.shift();
    if (w) w();
  };
  const macrotask = () =>
    new Promise((r) => {
      waiters.push(r);
      mc.port2.postMessage(0);
    });

  let advancing = false;
  async function advanceTo(target) {
    advancing = true;
    try {
      for (let guard = 0; guard < 200000; guard++) {
        let best = null;
        for (const t of timers.values()) {
          if (
            t.due <= target &&
            (!best || t.due < best.due || (t.due === best.due && t.order < best.order))
          )
            best = t;
        }
        if (!best) break;
        if (best.due > V) V = best.due;
        if (best.interval) {
          best.due += best.interval;
          best.order = seq++;
        } else {
          timers.delete(best.id);
        }
        firedTimers++;
        try {
          if (typeof best.cb === 'function') best.cb.apply(window, best.args);
        } catch (e) {
          console.error('[vclock] timer threw', e);
        }
        await macrotask();
      }
      if (target > V) V = target;
    } finally {
      advancing = false;
    }
  }
  function runRaf() {
    const q = rafQ;
    rafQ = new Map();
    for (const cb of q.values()) {
      firedRafs++;
      try {
        cb(V);
      } catch (e) {
        console.error('[vclock] rAF threw', e);
      }
    }
  }

  // Free-running before the recording: virtual time follows real time.
  let lastReal = R.now();
  async function pump() {
    if (!manual && !advancing) {
      const rn = R.now();
      const dt = Math.min(250, Math.max(0, rn - lastReal));
      lastReal = rn;
      await advanceTo(V + dt);
      if (!manual) runRaf();
    } else {
      lastReal = R.now();
    }
    R.raf(pump);
  }
  R.raf(pump);

  // Web Animations / CSS animations and transitions: paused, and seeked to
  // virtual time. `seen` holds each animation's virtual start.
  const seen = new WeakMap();
  let adoptRunning = true; // before recording: keep an animation's progress
  function seekDoc(doc) {
    let n = 0;
    let list;
    try {
      list = doc.getAnimations();
    } catch {
      return 0;
    }
    for (const a of list) {
      let s = seen.get(a);
      if (s === undefined) {
        if (a.playState === 'finished' || a.playState === 'idle') {
          seen.set(a, null);
          continue;
        }
        s = adoptRunning ? V - (Number(a.currentTime) || 0) : V;
        seen.set(a, s);
      }
      if (s === null) continue;
      const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
      const end = timing ? timing.endTime : Infinity;
      const t = V - s;
      if (a.playState === 'idle') continue;
      if (Number.isFinite(end) && t >= end) {
        if (a.playState !== 'finished') {
          try {
            a.finish();
          } catch {}
        }
        seen.set(a, null);
        continue;
      }
      try {
        if (a.playState !== 'paused') a.pause();
        a.currentTime = Math.max(0, t);
        n++;
      } catch {}
    }
    return n;
  }
  function seekAll() {
    let n = seekDoc(document);
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (f.contentDocument) n += seekDoc(f.contentDocument);
      } catch {}
    }
    return n;
  }
  const realFrame = () => new Promise((r) => R.raf(() => r()));

  window.__vclock = {
    get now() {
      return V;
    },
    get manual() {
      return manual;
    },
    setManual(on) {
      manual = !!on;
      lastReal = R.now();
      if (manual) {
        adoptRunning = true;
        seekAll();
        adoptRunning = false;
      }
      return V;
    },
    /** Advance `ms` of virtual time: due timers in order, then one rAF round. */
    async tick(ms) {
      await advanceTo(V + Math.max(0, ms));
      runRaf();
      await macrotask();
      await macrotask();
      return V;
    },
    /** Without moving time: what real-time callbacks (a ResizeObserver, an
     *  input event) queued since — timers already due and rAF callbacks —
     *  the way a 60 Hz browser would run them within the same 1/15 s. */
    async settle() {
      await advanceTo(V);
      runRaf();
      await macrotask();
      await macrotask();
      return V;
    },
    seek: seekAll,
    realFrame,
    macrotask,
    stats: () => ({ V, timers: timers.size, rafs: rafQ.size, firedTimers, firedRafs }),
  };

  // ------------------------------------------------- the desktop host's answers
  const KEEP = new Set(['3554:f517:sim-attack-shark-v8', '3151:5029:sim-attack-shark-r85he']);
  const keep = (list) => (Array.isArray(list) ? list.filter((d) => d && KEEP.has(d.id)) : list);
  const clone = (v) => (v === undefined ? v : structuredClone(v));

  const state = {
    profiles: [],
    switcher: {
      running: true,
      suspended: false,
      activeProfileId: null,
      pinnedProfileId: null,
      lastEvent: null,
      lastSwitch: null,
      applying: null,
      current: null,
    },
  };
  const subs = new Map(); // channel -> Set(cb)
  function emit(channel, payload) {
    const set = subs.get(channel);
    if (!set) return 0;
    const copy = clone(payload);
    for (const cb of [...set]) {
      try {
        cb(copy);
      } catch (e) {
        console.error('[tours] listener threw', e);
      }
    }
    return set.size;
  }

  function patch(api) {
    const on = api.on;
    api.on = (channel, cb) => {
      let set = subs.get(channel);
      if (!set) subs.set(channel, (set = new Set()));
      set.add(cb);
      // Live key travel comes only from the tour's own samples (a key the story
      // presses); the simulated board's stream reports nothing pressed.
      const wrapped =
        channel === 'devices:changed'
          ? (d) => cb(keep(d))
          : channel === 'device:travel'
            ? (p) => {
                if (p && p.__tour) cb(p);
              }
            : cb;
      const off = on(channel, wrapped);
      return () => {
        set.delete(cb);
        off();
      };
    };
    const listDevices = api.listDevices;
    api.listDevices = async (...a) => keep(await listDevices(...a));
    const getPlatformInfo = api.getPlatformInfo;
    api.getPlatformInfo = async () => ({
      ...(await getPlatformInfo()),
      // As main/platform/win.ts and main/ipc.ts answer in the installed app.
      os: 'win32',
      processSuffix: '.exe',
      processExample: 'cs2.exe',
      canOpenMouseSettings: true,
      nativeTrafficLights: false,
      isDev: false,
    });
    api.listProfiles = async () => clone(state.profiles);
    api.saveProfile = async () => clone(state.profiles);
    api.deleteProfile = async () => clone(state.profiles);
    api.getSwitcherState = async () => clone(state.switcher);
    api.setSwitcherRunning = async (on) => {
      state.switcher.running = !!on;
      return clone(state.switcher);
    };
    api.setSwitcherSuspended = async (s) => {
      state.switcher.suspended = !!s;
      return clone(state.switcher);
    };
    api.pinProfile = async () => clone(state.switcher);
    return api;
  }

  let api;
  Object.defineProperty(window, 'sharkdeck', {
    configurable: true,
    enumerable: true,
    get() {
      return api;
    },
    set(v) {
      api = v ? patch(v) : v;
    },
  });

  window.__toursHost = {
    state,
    emit,
    /** Mutate the switcher state and announce it, as main's emitState() does. */
    switcher(patchObj) {
      Object.assign(state.switcher, patchObj);
      return emit('switcher:state', state.switcher);
    },
    setProfiles(p) {
      state.profiles = clone(p);
      return emit('appProfiles:changed', undefined);
    },
    subscribers: () => [...subs.entries()].map(([k, v]) => [k, v.size]),
  };
})();
