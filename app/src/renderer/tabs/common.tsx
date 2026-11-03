import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { Capability } from '@shared/types/capability';
import type { LiveDevice, WriteResult } from '@shared/types/live';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { ArtAnchor, requestArtRemeasure, type ArtMode } from '../components/ArtAnchor';
import { PaneHeader } from '../components/common';
import {
  deviceCacheKey,
  deviceGeneration,
  dropDeviceCache,
  loadThroughCache,
  peekDeviceCache,
} from '../state/deviceCache';
import { sd } from '../state/bridge';
import { nextLiveValue } from './liveSync';

export interface TabProps {
  device: LiveDevice;
}

/** Re-exported so the tabs that already import it from here keep working. */
export { sd };

/**
 * Every `useDeviceData` registers itself here when a read fails, so
 * `DeviceConfig` can render ONE aggregate banner whose single button reloads
 * all of them — a disconnect can fail DPI, poll rate, sensor and power at
 * once, and a button per section is noise. `null` (no provider in scope) is a
 * valid, inert default: a section outside a device-config screen never
 * registers.
 */
export interface ReadFailureRegistry {
  register: (key: string, reload: () => void) => void;
  unregister: (key: string) => void;
}
export const ReadFailureContext = createContext<ReadFailureRegistry | null>(null);

/** Owns the registry state; DeviceConfig renders the aggregate banner from
 *  the same `failedCount`/`reloadAll` this returns, and wraps its tab content
 *  in `<ReadFailureContext.Provider value={registry}>`. */
export function useReadFailureRegistry() {
  const [failures, setFailures] = useState<Record<string, () => void>>({});
  const register = useCallback(
    (key: string, reload: () => void) =>
      setFailures((f) => (f[key] === reload ? f : { ...f, [key]: reload })),
    [],
  );
  const unregister = useCallback(
    (key: string) =>
      setFailures((f) => {
        if (!(key in f)) return f;
        const next = { ...f };
        delete next[key];
        return next;
      }),
    [],
  );
  const registry = useMemo(() => ({ register, unregister }), [register, unregister]);
  const reloadAll = useCallback(
    () => Object.values(failures).forEach((reload) => reload()),
    [failures],
  );
  return { registry, failedCount: Object.keys(failures).length, reloadAll };
}

/** Load async data once per device; expose { data, loading, reload }. Reports
 *  itself to the nearest `ReadFailureContext` (if any) whenever the load
 *  settles on `null` — see `useReadFailureRegistry`/`ReadFailed` below.
 *
 *  `deps` lets a caller whose `loader` closes over extra state (e.g. the
 *  keyboard remap pane's `layer`) re-read when that state changes — without it
 *  `reload` was keyed on `deviceId` alone, so flipping Base<->Fn kept showing
 *  the previously-read layer while writes went to the new one.
 *
 *  A per-call generation counter makes every `reload()` supersede any earlier
 *  in-flight one and blocks a `setState` after unmount, so a slow device read
 *  for A can't land in the UI after the user moved to B.
 *
 *  `cacheName` opts this read into the per-device cache (state/deviceCache.ts),
 *  which is what makes moving between tabs instant instead of a HID round trip
 *  and a spinner every time. Pass a stable name unique within the device; omit
 *  it for a read whose result depends on `deps` (there is one key per name, not
 *  per dep combination) or that must always hit the hardware. */
export { dropDeviceCache };

export function useDeviceData<T>(
  deviceId: string,
  loader: (id: string) => Promise<T>,
  initial: T,
  deps: readonly unknown[] = [],
  cacheName?: string,
) {
  const cacheKey = cacheName ? deviceCacheKey(deviceId, cacheName) : null;
  // Read the cache during the FIRST render, not in an effect: seeding state
  // afterwards would still paint one empty/spinner frame, which is the flicker
  // this exists to remove.
  const seed = useRef<{ hit: boolean; value?: T; stale: boolean }>(undefined as never);
  if (seed.current === undefined) seed.current = peekDeviceCache<T>(cacheKey);
  const seeded = seed.current;

  const [data, setData] = useState<T>(seeded.hit ? (seeded.value as T) : initial);
  const [loading, setLoading] = useState(!seeded.hit);
  // True only until the first load settles. A *refresh* — the re-read after a
  // write, or a live-poll follow-up — must not swap a spinner in where the
  // value was: the row changes height, everything below it jumps, and the
  // control the user is still working with moves out from under the pointer.
  // Panes render their `<Loading/>` on this, never on `loading`.
  const [firstLoad, setFirstLoad] = useState(!seeded.hit);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const key = useId();
  const registry = useContext(ReadFailureContext);
  const gen = useRef(0);

  useEffect(() => () => void gen.current++, []); // invalidate in-flight loads on unmount

  /**
   * @param quiet a background check behind an already-displayed cached value:
   *   it must not raise the spinner, and a `null` answer leaves what is on
   *   screen alone. We have a real value and no evidence it changed, so
   *   replacing it with a read-failure over one missed report would be worse
   *   than showing it.
   */
  const load = useCallback(
    (quiet: boolean) => {
      const mine = ++gen.current;
      if (!quiet) setLoading(true);
      loadThroughCache(cacheKey, () => loaderRef.current(deviceId))
        .then((v) => {
          if (mine !== gen.current) return;
          if (quiet && (v === null || v === undefined)) return;
          setData(v);
        })
        .catch(() => undefined)
        .finally(() => {
          if (mine !== gen.current) return;
          setLoading(false);
          setFirstLoad(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceId, cacheKey, ...deps],
  );

  /** Always hits the device — the Re-read button and the re-read after a
   *  write both mean "what does it say *now*". Writes through the cache. */
  const reload = useCallback(() => load(false), [load]);

  // The seed only excuses the FIRST load. A later `load` identity change means
  // `deviceId` or a `deps` value moved, and that read genuinely has to happen —
  // skipping it because the original mount happened to be cache-fresh would
  // leave the pane showing the previous device's or the previous layer's data.
  const usedSeed = useRef(false);
  useEffect(() => {
    if (!usedSeed.current) {
      usedSeed.current = true;
      // A fresh cached value is already on screen; leave it be. A stale one is
      // shown too, but checked quietly behind the user's back.
      if (seeded.hit && !seeded.stale) return;
      load(seeded.hit);
      return;
    }
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (!registry) return;
    if (!loading && data === null) registry.register(key, reload);
    else registry.unregister(key);
    return () => registry.unregister(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, key, loading, data, reload]);

  return { data, setData, loading, firstLoad, reload };
}

/**
 * Warm the cache for every read this device's tabs will want, in the
 * background, while the user is looking at the first one.
 *
 * Config panes load on mount, so without this each tab switch is a fresh HID
 * round trip and a "Reading from device…" wait — for values that were sitting
 * there unchanged. HID is slow and serialised; the reads have to happen
 * eventually either way, so the only question is whether the user waits for
 * them. Here they happen while they are reading the first tab.
 *
 * Ordered by how soon a tab is likely to be opened, one at a time rather than
 * all at once: the channel serialises them regardless, and a burst against a
 * dozing mouse is how reads start getting dropped. Anything already cached is
 * skipped, and `loadThroughCache` means a pane that mounts mid-prefetch joins
 * the read already in flight instead of starting a second one.
 *
 * Returns a cancel function — leaving the menu should stop the queue rather
 * than keep talking to a device nobody is looking at.
 */
export function prefetchDeviceReads(device: LiveDevice): () => void {
  const has = (c: Capability) => device.capabilities.includes(c);
  const jobs: [string, () => Promise<unknown>][] = [];
  const add = (name: string, when: boolean, run: () => Promise<unknown>) => {
    if (when) jobs.push([name, run]);
  };

  add('dpiStages', has('dpi'), () => sd.readDpiStages(device.id));
  add('activeDpiStage', has('dpi'), () => sd.readActiveDpiStage(device.id));
  add('pollRate', has('pollRate'), () => sd.readPollRate(device.id));
  add('sensor', has('sensorTuning'), () => sd.readSensor(device.id));
  add('power', has('sleepTimer'), () => sd.readPower(device.id));
  add('debounce', has('mouseDebounce') || has('debounce'), () => sd.readDebounce(device.id));
  add('buttons', has('buttonRemap'), () => sd.readButtons(device.id));
  add('dpiLed', has('dpiIndicatorLed'), () => sd.readDpiLed(device.id));
  add('receiverLed', has('receiverLed'), () => sd.readReceiverLed(device.id));
  add('lighting', has('mouseLighting') || has('perKeyLighting') || has('sideLighting'), () =>
    sd.readLighting(device.id),
  );
  add('sideLighting', has('sideLighting'), () => sd.readSideLighting(device.id));
  add('perKeyLighting', has('perKeyLighting'), () => sd.readPerKeyLighting(device.id));
  add('firmware', true, () => sd.getFirmware(device.id));
  // Deliberately NOT prefetched: `readMacros` sweeps all 16 onboard slots,
  // chunked, which is by far the most expensive read the mouse has — seconds
  // of traffic contending with the live poll, spent on a tab most sessions
  // never open. It still caches once visited, so going back to it is instant.

  let cancelled = false;
  void (async () => {
    for (const [name, run] of jobs) {
      if (cancelled) return;
      const key = deviceCacheKey(device.id, name);
      if (peekDeviceCache(key).hit) continue;
      // One failed read must not abandon the rest of the queue — a device that
      // drops one report usually answers the next.
      await loadThroughCache(key, run).catch(() => undefined);
    }
  })();
  return () => {
    cancelled = true;
  };
}

/**
 * Is this an unpackaged (developer) build?
 *
 * `PlatformInfo.isDev` is `!app.isPackaged` — the same flag that decides whether
 * the Simulated-devices row exists in Settings, so there is no second notion
 * of "dev" to keep in step.
 */
export function useIsDev(): boolean {
  return useStore((s) => s.platformInfo?.isDev ?? false);
}

/** Non-hook form, for code paths that are not a component render (toasts). */
export function isDevBuild(): boolean {
  return useStore.getState().platformInfo?.isDev ?? false;
}

/**
 * A note about how well a protocol command is understood — "unconfirmed on
 * hardware", "best-effort", "not yet verified against a capture".
 *
 * These are notes to whoever is developing the protocol, not to someone using
 * their keyboard: a person who just wants a different actuation point cannot
 * act on "the action byte is not yet confirmed", and a UI dotted with
 * confidence disclaimers reads as broken rather than careful. So they are
 * shown only in unpackaged builds.
 *
 * This does NOT cover copy that explains something the user can actually see —
 * why the firmware field is blank, why Flash is disabled, why a preview is
 * approximate. Those stay visible in every build, because the state they
 * explain is visible in every build. The safety machinery is unaffected either
 * way: the backup-before-first-write guarantee and the read-back check on every
 * change do not depend on whether their caveat is on screen.
 */
export function DevNote({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const isDev = useIsDev();
  if (!isDev) return null;
  return (
    <p className="hint dev-note" style={style}>
      {children}
    </p>
  );
}
/** Wrap a write call: surfaces a toast with the verification outcome. */
export function useWrite() {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const [last, setLast] = useState<WriteResult | null>(null);
  const run = useCallback(
    async (label: string, fn: () => Promise<WriteResult>) => {
      // A write can now REJECT rather than resolve to `{ok:false}`: the device
      // being unplugged mid-write always could, and a channel that blows a
      // native-call deadline (HidWedgedError, see main/hid/transport.ts) does
      // too. Uncaught, that surfaced as an unhandled rejection in the renderer
      // and no toast at all — the write just appeared to do nothing. Fold it
      // into the same failed-write shape every caller already handles.
      let r: WriteResult;
      try {
        r = await fn();
      } catch (err) {
        r = { ok: false, verified: 'unverified', error: String((err as Error)?.message ?? err) };
      }
      setLast(r);
      // "no read-back available to confirm" and "applied and confirmed" are the
      // same outcome as far as anyone using their keyboard is concerned: the
      // setting was sent and nothing failed. The distinction is about how much
      // of the protocol we can verify, which is developer information (see
      // DevNote) — and phrasing a successful write as a caveat made ordinary
      // use feel unreliable. Shipped builds say "applied"; `unverified` still
      // never claims to be *confirmed*.
      // In the app's language — the wording around the label was English in
      // every one. (The device's own error text and `note` come from the main
      // process and stay as they are.)
      if (!r.ok) toast('err', t('write.error', { label, error: r.error ?? t('write.failed') }));
      // A multi-field write where the confirmed fields landed but one
      // `inferred` offset did not (see WriteResult.note). `note` short-circuits
      // the mismatch branch below so one action produces one warning, and so
      // the fields that demonstrably worked are not slandered by it.
      else if (r.note) toast('warn', t('write.appliedBut', { label, note: r.note }));
      else if (r.verified === 'mismatch') toast('warn', t('write.mismatch', { label }));
      else if (r.verified === 'unverified')
        toast(
          'info',
          isDevBuild() ? t('write.unverified', { label }) : t('write.applied', { label }),
        );
      else toast('info', t('write.confirmed', { label }));
      return r;
    },
    [toast, t],
  );
  return { run, last };
}

/**
 * Hold the device's config menu while a slow write is in flight.
 *
 * HID is serialised and unhurried: putting 79 keys back to default, or
 * switching profile (which rewrites the whole per-profile block and then
 * re-reads every pane), takes seconds. Until now nothing said so — the click
 * returned immediately, the panel showed the new values straight away, and the
 * only clue that anything was still happening was the keyboard not responding.
 * People reasonably concluded it had finished and went somewhere else, which
 * is exactly the moment a second write collides with the first.
 *
 * `whileBusy` marks the device busy for the lifetime of `run`, and
 * `DeviceConfig` turns that into one overlay plus an inert menu. The flag is
 * in the store, not here, because a profile switch remounts this pane
 * mid-operation — see `deviceBusy`.
 */
export function useDeviceBusy(deviceId: string) {
  const begin = useStore((s) => s.beginDeviceBusy);
  const busy = useStore((s) => !!s.deviceBusy[deviceId]);
  const whileBusy = useCallback(
    async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
      const end = begin(deviceId, label);
      try {
        return await run();
      } finally {
        end();
      }
    },
    [begin, deviceId],
  );
  return { busy, whileBusy };
}

/**
 * Whether this device's tab is the one on screen.
 *
 * Every device tab stays mounted behind `.view-hidden` (App.tsx hides rather
 * than unmounts), so a pane's window-level key handling is live in every tab
 * ever opened unless it asks this first. A selection left on one keyboard's
 * Actuation tab used to go on swallowing keys — and holding the app-wide key
 * capture, so Ctrl+Tab and Ctrl+W were dead — from Home, Settings and every
 * other device's tab.
 */
export function useDeviceTabOnScreen(deviceId: string): boolean {
  return useStore((s) => s.activeTabId === `device:${deviceId}`);
}

/**
 * The block itself: a scrim over the device menu with what is happening.
 *
 * Deliberately covers only the menu — the title bar and the tab strip stay
 * live, so a write that never returns cannot trap someone in a window they
 * cannot close. Same reasoning as the offline banner sitting OUTSIDE the
 * `fieldset` that disables everything else.
 */
export function BusyOverlay({ label }: { label: string }) {
  const t = useT();
  return (
    <div className="busy-scrim" role="status" aria-live="polite">
      <div className="busy-card">
        <span className="spinner" aria-hidden="true" />
        <div>
          <div className="busy-label">{label}</div>
          <div className="busy-sub">{t('busy.sub')}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Auto-commit: the app has no "Apply" buttons — a setting is written the
 * moment it's changed. Built on `useWrite`, so the bottom-right toast is the
 * only write-outcome UI.
 *
 *  - `commit(label, fn)`  — immediate; for toggles, selects, colour pickers,
 *                           segmented controls.
 *  - `queue(label, fn)`   — debounced (default 250 ms); for a slider or number
 *                           field the user sweeps through many values. Call
 *                           `flush()` on pointer-up / blur to write at once.
 *
 * A pending debounced write is flushed on unmount so a value change isn't
 * silently dropped by navigating away.
 *
 * `onSettled` fires once per completed write, after the toast. A pane whose
 * controls mirror device state into local `useState` uses it to re-read the
 * device, so the panel ends up showing what the hardware actually took rather
 * than what was requested — the two differ whenever a field is clamped,
 * ignored, or gated by another byte.
 */
export function useAutoWrite(
  delay = 250,
  opts?: { onSettled?: (r: WriteResult) => void; deviceId?: string },
) {
  const { run, last } = useWrite();
  // Kept in a ref so a caller can pass an inline arrow without re-creating
  // `queue`/`commit` on every render (which would drop a pending debounce).
  const settled = useRef(opts?.onSettled);
  settled.current = opts?.onSettled;
  const deviceId = opts?.deviceId;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{
    label: string;
    fn: () => Promise<WriteResult>;
    gen: number | null;
  } | null>(null);

  const fire = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    // A queued write describes the device state the pane last READ. If that
    // state has since been thrown away — a profile switch, or the device going
    // away — the write would land on a slot it was never computed for, and the
    // unmount flush below would do exactly that, because a profile switch is
    // what unmounts the pane. Drop it instead. `commit` is never gated this
    // way: it is a deliberate click happening now, on the pane in front of the
    // user.
    if (p.gen !== null && deviceId !== undefined && deviceGeneration(deviceId) !== p.gen) return;
    void run(p.label, p.fn).then((r) => settled.current?.(r));
  }, [run, deviceId]);

  const queue = useCallback(
    (label: string, fn: () => Promise<WriteResult>) => {
      pending.current = {
        label,
        fn,
        gen: deviceId === undefined ? null : deviceGeneration(deviceId),
      };
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(fire, delay);
    },
    [fire, delay, deviceId],
  );

  const commit = useCallback(
    (label: string, fn: () => Promise<WriteResult>) => {
      // Flush any queued (debounced) write FIRST, then run this immediate one —
      // otherwise a `commit` that lands within the debounce window of a prior
      // `queue` (e.g. clicking a toggle right after dragging a slider) silently
      // drops the queued value while the UI has already moved to it.
      fire();
      // Returned, not swallowed: most callers are fire-and-forget, but one
      // that has to hold the UI until the device answers (see useDeviceBusy)
      // needs something to await.
      return run(label, fn).then((r) => {
        settled.current?.(r);
        return r;
      });
    },
    [run, fire],
  );

  useEffect(() => () => fire(), [fire]);
  return { queue, commit, flush: fire, last };
}

/**
 * Follow a value the device reports on its own, without fighting the user.
 *
 * Some settings — DPI stage, polling rate — can be changed with the mouse's
 * own buttons, so the manager polls them while a device screen is open and
 * publishes them on `LiveDevice`. This adopts those reports into a section's
 * existing local state.
 *
 * Two things it deliberately does NOT do:
 *  - no device I/O and no `useWrite`, so a value arriving from the hardware
 *    can never raise a toast (nothing was written);
 *  - no remount — it touches only this section's own state, unlike the
 *    `configEpoch` bump a profile switch triggers, which re-reads the whole
 *    pane and is far too heavy for a button someone can press twice a second.
 *
 * Call `note(v)` alongside an optimistic local set so an in-flight poll that
 * predates the write cannot undo it; pass `held` to freeze adoption entirely
 * while a drag or an edit is in progress. See `nextLiveValue` for the rules.
 */
export function useLiveSync<T>(
  remote: T | null,
  current: T | null,
  apply: (v: T) => void,
  opts: { holdMs?: number; held?: () => boolean } = {},
) {
  const holdMs = opts.holdMs ?? 2500;
  const pin = useRef<{ to: T | null; until: number }>({ to: null, until: 0 });
  // Refs, not deps: the effect must run when the DEVICE reports something new,
  // not every time the section re-renders with a new inline `held` closure.
  const currentRef = useRef(current);
  currentRef.current = current;
  const heldRef = useRef(opts.held);
  heldRef.current = opts.held;
  const applyRef = useRef(apply);
  applyRef.current = apply;

  const note = useCallback(
    (v: T) => {
      pin.current = { to: v, until: Date.now() + holdMs };
    },
    [holdMs],
  );

  useEffect(() => {
    const { value, clearPin } = nextLiveValue<T>({
      remote,
      local: currentRef.current,
      pinnedTo: pin.current.to,
      pinnedUntil: pin.current.until,
      now: Date.now(),
      held: heldRef.current?.() ?? false,
    });
    if (clearPin) pin.current = { to: null, until: 0 };
    if (value !== null && value !== currentRef.current) applyRef.current(value);
  }, [remote]);

  return { note };
}

/**
 * Shown while a device read is in flight, so a pane waiting on HID never
 * looks empty — or worse, looks like it is showing real device state when
 * those values are still placeholders.
 *
 * The spinner carries the label with it: `@media (prefers-reduced-motion)`
 * neutralises animations globally in styles.css, and `.spinner` deliberately
 * opts back in there (a loading affordance is functional, not decorative),
 * but the text means this still reads correctly either way.
 *
 * `inline` drops the block padding for use inside an existing row. `label`
 * replaces the default "Reading from device…" — for the operations that are
 * writing rather than reading (a restore replaying every block, a pairing
 * waiting on the radio), where that wording would be plainly wrong.
 */
export function Loading({ inline = false, label }: { inline?: boolean; label?: string } = {}) {
  const t = useT();
  return (
    <div className={inline ? 'loading loading-inline' : 'loading'} role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {/* Default key name is legacy (it predates this component and is not
          DPI-specific); the string is "Reading from device…" and is already
          translated in every locale, so it is reused rather than duplicated. */}
      <span>{label ?? t('dpi.reading')}</span>
    </div>
  );
}

/**
 * Shown in place of a control when a device read returned null — i.e. the
 * device genuinely did not answer. Never a fabricated value. No button of
 * its own any more — `useDeviceData` already registered this failure with
 * the nearest `ReadFailureContext`, and `DeviceConfig` renders one "Re-read"
 * for the whole menu that reloads every failed section at once, instead of
 * one button per section.
 */
export function ReadFailed() {
  const t = useT();
  return (
    <div className="readfail">
      <div style={{ color: 'var(--text-dim)', marginBottom: 2 }}>{t('cfg.readFailed')}</div>
      <div>{t('cfg.readFailed.sub')}</div>
    </div>
  );
}

/**
 * The standard "hero photo + content" tab shell: the photo (plus an optional
 * close-up detail shot) in a fixed left column, tab content beside it. Used by
 * Profile, Buttons, Macros, Device and the mouse-only Lighting sub-panes.
 *
 * `is-keyboard` tells styles/device-art.css to size the art column for a
 * keyboard's wider photo (`--hero-art-h`) rather than a mouse's taller one.
 * Keys, Actuation and Lighting's board panes deliberately do NOT use this —
 * see docs/design/renderer-layout.md.
 */
export function HeroPane({
  device,
  title,
  sub,
  detail,
  artMode,
  children,
}: {
  device: LiveDevice;
  /** A plain heading, or a `TitleTabs` that IS the heading — same rule as
   *  PaneHeader's `title`, so a hero pane can carry sub-views too. */
  title: string | ReactNode;
  sub: string;
  /** an extra close-up photo shown beside the main hero shot — mouse only */
  detail?: { src: string; alt: string };
  /** 'interactive' (the Buttons tab, when the model has a buttonMap) — same
   *  size box as the plain hero photo (below), just telling PersistentDeviceArt
   *  to draw the numbered badges directly on it there (see its own doc
   *  comment); this pane has no local art content of its own to render
   *  either way. */
  artMode?: ArtMode;
  children: ReactNode;
}) {
  const isKeyboard = device.kind === 'keyboard';
  return (
    <div className={`pane hero-side ${isKeyboard ? 'is-keyboard' : ''}`}>
      {/* The same header every pane has: the title, its description as an
          info dot rather than a paragraph. */}
      <PaneHeader title={title} sub={sub} />
      <div className={`hero-art-col ${detail ? 'has-detail' : ''}`}>
        <ArtAnchor mode={artMode ?? 'hero'} className="art-hero-anchor" />
        {/* Same reason as MouseLightingContainer's copy of this: the detail
            photo is a SIBLING of the anchor, so its decode re-lays-out the
            column without anything the anchor watches noticing. */}
        {detail && (
          <img
            key={detail.src}
            className="led-detail-art"
            src={detail.src}
            alt={detail.alt}
            draggable={false}
            onLoad={() => requestArtRemeasure()}
          />
        )}
      </div>
      <div className="hero-side-content">{children}</div>
    </div>
  );
}

export function NotWired({ feature }: { feature: string }) {
  const t = useT();
  return (
    <div className="empty">
      <p style={{ marginBottom: 8 }}>{feature}</p>
      <p style={{ fontSize: 12 }}>{t('cfg.notWired')}</p>
    </div>
  );
}
