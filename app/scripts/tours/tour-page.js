// Evaluated once in the app page by tour3.cjs / harness.cjs (after load). Defines window.__tour:
// the cursor sprite, the caption chip, the switch card (the real overlay.html in
// an iframe), cursor targets read off the live layout, and the per-frame step.
(() => {
  const STORE = '/@fs/__APP__/src/renderer/state/store.ts';
  const OVERLAY = '/@fs/__APP__/src/renderer/overlay.html';
  const host = window.__toursHost;
  const clock = window.__vclock;
  let useStore = null;
  let cursorEl = null;
  let captionEl = null;
  let frameEl = null;
  let lastCaption = '';
  let lastAt = 0;
  let travelTimer = null;
  const scrolls = new Map(); // scroll action key -> { el, from, to }

  const vis = (el) => !!el && el.getClientRects().length > 0;
  const all = (sel) => [...document.querySelectorAll(sel)].filter(vis);
  const rect = (el) => el.getBoundingClientRect();

  async function settings(patch) {
    const s = useStore.getState().settings;
    useStore.setState({ settings: { ...s, ...patch } });
    // Kept in step with storage too, as the app's own setter would.
    await window.sharkdeck.setSettings(patch).catch(() => null);
  }

  const T = {
    async setup(cfg) {
      ({ useStore } = await import(STORE));
      const css = document.createElement('style');
      css.id = 'tour-css';
      css.textContent = `
        .demo-strip, .card-hint { display: none !important; }
        #tour-cursor { position: fixed; left: 0; top: 0; width: 14px; height: 21px; z-index: 2147483647;
          pointer-events: none; display: none; filter: drop-shadow(0 1px 1.2px rgba(0,0,0,.55)); }
        #tour-caption { position: fixed; left: 50%; bottom: 40px; z-index: 2147483645; pointer-events: none;
          display: flex; align-items: center; gap: 11px; padding: 11px 20px 11px 16px; border-radius: 999px;
          background: rgba(12, 15, 21, .88); border: 1px solid rgba(255, 255, 255, .09);
          box-shadow: 0 10px 30px rgba(0, 0, 0, .45); color: #fff; white-space: nowrap; opacity: 0;
          font: 650 15px/1.2 Inter, 'Segoe UI', system-ui, sans-serif; transform: translateX(-50%); }
        #tour-caption .dot { width: 8px; height: 8px; border-radius: 50%; flex: none;
          background: #3df8e8; box-shadow: 0 0 9px rgba(61, 248, 232, .85); }
        #tour-caption .tag { margin-left: 3px; color: #9aa7ba; font: 500 13px/1 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace; }
        #tour-overlay { position: fixed; right: 24px; bottom: 24px; width: 300px; height: 160px; border: 0;
          background: transparent; z-index: 2147483646; pointer-events: none; visibility: hidden; color-scheme: normal; }
      `;
      document.head.appendChild(css);

      cursorEl = document.createElement('div');
      cursorEl.id = 'tour-cursor';
      cursorEl.innerHTML =
        '<svg width="14" height="21" viewBox="0 0 14 21" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M1 1 L1 17.2 L4.9 13.5 L7.6 19.7 L10.1 18.6 L7.5 12.6 L12.6 12.6 Z" fill="#fff" stroke="#000" ' +
        'stroke-width="1.15" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cursorEl);

      captionEl = document.createElement('div');
      captionEl.id = 'tour-caption';
      captionEl.innerHTML =
        '<span class="dot"></span><span class="text"></span><span class="tag"></span>';
      document.body.appendChild(captionEl);

      frameEl = document.createElement('iframe');
      frameEl.id = 'tour-overlay';
      frameEl.src = OVERLAY;
      document.body.appendChild(frameEl);
      await new Promise((r) => frameEl.addEventListener('load', r, { once: true }));
      // overlay.ts subscribes when its module runs; wait until it has.
      for (let i = 0; i < 100; i++) {
        const w = frameEl.contentWindow;
        if (w && w.__overlaySend && w.__overlaySend('pointer', { x: -9999, y: -9999 }) > 0) break;
        await new Promise((r) => window.__R.setTimeout(r, 50));
      }

      host.setProfiles(cfg.profiles);
      host.switcher(cfg.switcher);
      await settings(cfg.settings);
      return T.state();
    },

    state() {
      const w = frameEl && frameEl.contentWindow;
      return {
        devices: useStore.getState().devices.map((d) => [d.id, d.activeProfile]),
        tabs: useStore.getState().tabs.map((t) => t.id),
        active: useStore.getState().activeTabId,
        overlaySubs: w && w.__overlaySend ? w.__overlaySend('pointer', { x: -9999, y: -9999 }) : -1,
        switcher: useStore.getState().switcher,
        settings: useStore.getState().settings,
        clock: clock.stats(),
      };
    },

    openTab(route) {
      useStore.getState().openTab(route);
      return useStore.getState().activeTabId;
    },

    /**
     * A point on screen, from a spec: a target name, [x, y], or
     * { sel, text, exact, index, within, fx, fy, dx, dy, textRange } — the
     * index-th VISIBLE element matching `sel` (inside `within`) whose text
     * includes `text`; then fx/fy across its box (or its text) plus dx/dy.
     */
    resolve(spec) {
      if (typeof spec === 'string') return T.target(spec);
      if (Array.isArray(spec)) return spec;
      const el = T.find(spec);
      if (!el) throw new Error('no element for ' + JSON.stringify(spec));
      let r = rect(el);
      if (spec.textRange) {
        const range = document.createRange();
        range.selectNodeContents(el);
        r = range.getBoundingClientRect();
      }
      return [
        r.left + r.width * (spec.fx ?? 0.5) + (spec.dx ?? 0),
        r.top + r.height * (spec.fy ?? 0.5) + (spec.dy ?? 0),
      ];
    },
    find(spec) {
      const root = spec.within
        ? T.find(typeof spec.within === 'string' ? { sel: spec.within } : spec.within)
        : document;
      if (!root) return null;
      let els = [...root.querySelectorAll(spec.sel)].filter(vis);
      if (spec.text != null) {
        els = els.filter((e) =>
          spec.exact
            ? e.textContent.trim() === spec.text
            : e.textContent.trim().includes(spec.text),
        );
      }
      if (spec.inView)
        els = els.filter((e) => {
          const b = rect(e);
          return b.bottom > 0 && b.top < innerHeight;
        });
      return els[spec.index ?? 0] || null;
    },
    rect(spec) {
      const el = T.find(spec);
      if (!el) return null;
      const r = rect(el);
      return [r.left, r.top, r.width, r.height];
    },

    /** Live key travel as the board reports it: one sample every `period` ms
     *  of virtual time, the key's depth read off `keys` ([ms, mm] points). */
    travel({ id, slot, keys, period = 150, loop = false }) {
      T.travelStop();
      const start = performance.now();
      const span = keys[keys.length - 1][0];
      const depth = (ms) => {
        if (loop) ms %= span;
        if (ms >= span) return keys[keys.length - 1][1];
        for (let i = 1; i < keys.length; i++) {
          const [t1, d1] = keys[i];
          const [t0, d0] = keys[i - 1];
          if (ms <= t1) return d0 + ((d1 - d0) * (ms - t0)) / Math.max(1, t1 - t0);
        }
        return 0;
      };
      const emit = () => {
        const mm = +depth(performance.now() - start).toFixed(2);
        host.emit('device:travel', {
          id,
          raw: '',
          keys: mm > 0.02 ? [{ slot, mm }] : [],
          complete: true,
          __tour: true,
        });
      };
      travelTimer = setInterval(emit, period);
      return { start, span };
    },
    travelStop() {
      if (travelTimer) clearInterval(travelTimer);
      travelTimer = null;
      return true;
    },

    /** Where the cursor goes, read off the layout on screen now. */
    target(name) {
      const cards = all('.grid .card');
      const card = (txt) => cards.find((c) => c.textContent.includes(txt));
      switch (name) {
        case 'logo': {
          const r = rect(all('.brand-word')[0]);
          return [r.left + r.width * 0.82, r.top + r.height * 0.55];
        }
        case 'chevron': {
          const r = rect(all('.autoswitch-group .topbar-btn.icon-only')[0]);
          return [r.left + r.width * 0.5, r.top + r.height * 0.5];
        }
        case 'modes': {
          // Just past the end of the Gaming row's "3 on · 1 off", pointing at it.
          const row = all('.as-table tbody tr').find((tr) => tr.textContent.includes('Gaming'));
          const cell = row.querySelector('.as-triggers-cell');
          const range = document.createRange();
          range.selectNodeContents(cell);
          const tr = range.getBoundingClientRect();
          return [tr.right + 5, tr.top + tr.height * 0.62];
        }
        case 'game': {
          // Just past the end of the "Counter-Strike 2" label.
          const row = all('.as-trigger-row').find((x) =>
            x.textContent.includes('Counter-Strike 2'),
          );
          const label = row.querySelector('.as-process-icon').nextElementSibling;
          const range = document.createRange();
          range.selectNodeContents(label);
          const tr = range.getBoundingClientRect();
          return [tr.right + 6, tr.top + tr.height * 0.62];
        }
        case 'center': {
          const a = rect(card('V8'));
          const b = rect(card('R85HE'));
          return [(a.right + b.left) / 2, a.top + a.height * 0.43];
        }
        case 'v8chip':
        case 'r85chip': {
          const c = card(name === 'v8chip' ? 'V8' : 'R85HE');
          const pill = [...c.querySelectorAll('.meta .pill')].find((p) =>
            /Profile/.test(p.textContent),
          );
          const chip = rect(pill);
          return [chip.left + chip.width * 0.5, rect(c).bottom + 4];
        }
      }
      throw new Error('unknown target ' + name);
    },

    /** One output frame: apply the story, advance virtual time, settle. */
    async frame(a) {
      if (a.cursor) {
        cursorEl.style.display = 'block';
        cursorEl.style.transform = `translate(${(a.cursor[0] - 1).toFixed(2)}px, ${(a.cursor[1] - 1).toFixed(2)}px)`;
      } else {
        cursorEl.style.display = 'none';
      }
      if (a.caption && a.caption.alpha > 0) {
        const key = a.caption.text + '|' + a.caption.tag;
        if (key !== lastCaption) {
          captionEl.querySelector('.text').textContent = a.caption.text;
          captionEl.querySelector('.tag').textContent = a.caption.tag;
          lastCaption = key;
        }
        captionEl.style.opacity = String(a.caption.alpha);
        captionEl.style.transform = `translateX(-50%) translateY(${((1 - a.caption.alpha) * 8).toFixed(2)}px)`;
      } else {
        captionEl.style.opacity = '0';
      }
      const fw = frameEl.contentWindow;
      for (const act of a.actions || []) {
        switch (act.type) {
          case 'settings':
            await settings(act.patch);
            break;
          case 'switcher':
            host.switcher(act.patch);
            break;
          case 'lastSwitch':
            // As switcher.ts records it: `at` is the switch's Date.now(), which
            // is also the switch card's id (overlayWindow.ts `id: app.at`).
            lastAt = Date.now();
            host.switcher({
              lastEvent: act.lastEvent,
              lastSwitch: { ...act.lastSwitch, at: lastAt },
            });
            break;
          case 'slot':
            // Not awaited: the write settles on virtual time, during the tick.
            window.sharkdeck.setActiveProfile(act.id, act.slot);
            break;
          case 'overlay':
            fw.__overlaySend('content', { ...act.content, id: lastAt });
            frameEl.style.visibility = 'visible';
            frameEl.style.opacity = '1';
            break;
          case 'overlayOpacity':
            frameEl.style.opacity = String(act.value);
            break;
          case 'store':
            useStore.setState(act.patch);
            break;
          case 'scroll': {
            // A smooth scroll the story times itself: start and end fixed on
            // the first frame, then one eased position per frame.
            let sc = scrolls.get(act.key);
            if (!sc) {
              const el = T.find(typeof act.el === 'string' ? { sel: act.el } : act.el);
              let to = act.to;
              if (typeof to !== 'number') {
                const tg = T.find(to);
                to = el.scrollTop + (rect(tg).top - rect(el).top) - (act.offset || 0);
              }
              to = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, to));
              sc = { el, from: el.scrollTop, to };
              scrolls.set(act.key, sc);
            }
            sc.el.scrollTop = sc.from + (sc.to - sc.from) * act.p;
            break;
          }
        }
      }
      if (a.cursor && frameEl.style.visibility === 'visible') {
        // What main/overlayWindow.ts samples: the pointer in the card window's coordinates.
        const r = rect(frameEl);
        fw.__overlaySend('pointer', {
          x: Math.round(a.cursor[0] - r.left),
          y: Math.round(a.cursor[1] - r.top),
        });
      }
      await clock.macrotask();
      await clock.macrotask();
      await clock.tick(a.tickMs);
      // Chains that need a laid-out frame first (ResizeObserver -> rAF, as the
      // device art's anchors do) finish within the same output frame.
      for (let i = 0; i < 2; i++) {
        await clock.realFrame();
        await clock.settle();
      }
      clock.seek();
      await clock.realFrame();
      clock.seek();
      await clock.realFrame();
      if (a.debug) {
        const view = [...document.querySelectorAll('.content > .view')].find(
          (v) => !v.classList.contains('view-hidden'),
        );
        const cs = view && getComputedStyle(view);
        return {
          V: clock.now,
          anims: document.getAnimations().map((x) => {
            const tgt = x.effect && x.effect.target;
            return `${x.animationName || x.transitionProperty || x.constructor.name}@${tgt ? tgt.className.toString().slice(0, 30) : '?'}:${x.playState}:${Math.round(x.currentTime)}`;
          }),
          view: view
            ? {
                cls: view.className,
                transform: cs.transform,
                opacity: cs.opacity,
                top: Math.round(view.getBoundingClientRect().top),
              }
            : null,
          scroll: document.querySelector('.content')
            ? document.querySelector('.content').scrollTop
            : null,
        };
      }
      return { V: clock.now };
    },
  };
  window.__tour = T;
  return true;
})();
