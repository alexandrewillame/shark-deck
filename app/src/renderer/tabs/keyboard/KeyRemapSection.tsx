import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';
import { ConfirmDialog, Panel, Row, Tooltip } from '../../components/common';
import { KeyboardMap, type KeyRef } from '../../components/KeyboardMap';
import { ArtAnchor } from '../../components/ArtAnchor';
import {
  type TabProps,
  sd,
  useWrite,
  useDeviceData,
  useDeviceTabOnScreen,
  Loading,
} from '../common';
import { KEY_DISABLED_CODE, hidUsageForBrowserCode } from '@shared/keys';
import { slotOf } from '../../keyLayout';
import { useT } from '../../state/i18n';
import { NAVIGATION_SURFACES, usePendingChange } from '../../state/leaveGuard';
import { keyNameForCode, useIsMac } from '../../state/shortcuts';
import {
  COMBO_MAX,
  type RemapPick,
  differsFromFactory,
  factoryBinding,
  factoryCode,
  heldModifiers,
  isRemapped,
  isUnbound,
  pickAction,
  pickHas,
  pickOf,
  quadBytes,
  resetCodeOf,
  togglePick,
} from './keyRemapState';
import { KeyCap, quadFace, usageFace } from './remapKeyFace';
import { KeyPicker } from './KeyPicker';
import { REMAP_GROUPS } from './remapGroups';
import { decodeKeyQuad, quadLabel } from '@shared/keyboard-fn-codes';
import { Icon } from '../../components/icons';

/**
 * Fn-layer binding kinds that count as "this key does something".
 *
 * All of them — what separates a binding from firmware behaviour is the
 * driver's `locked` flag, not the quad's type. `[10,9,0,0]` is a `system`
 * quad AND an assignable action (lighting on/off), while `[13,8,…]` is a
 * `lighting` quad that is not assignable at all, so neither type sorts
 * cleanly. See ASSIGNABLE_QUADS in shared/keyboard-fn-codes.ts.
 */
const FN_BOUND_KINDS = new Set<KeyBinding['kind']>(['key', 'consumer', 'lighting', 'system']);

export function KeyRemapSection({ device, layer }: TabProps & { layer: 'base' | 'fn' }) {
  const t = useT();
  // Right Alt is Right Option on a Mac keyboard.
  const isMac = useIsMac();
  const layout = device.ui.keyMatrix?.layout;
  const { run } = useWrite();
  const [sel, setSel] = useState<KeyRef | null>(null);
  const onScreen = useDeviceTabOnScreen(device.id);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  /**
   * What is staged for the selected key — usages, or one media/launcher quad
   * (see RemapPick) — or `null` for "showing what is already bound".
   *
   * The picker used to write on every click, which made a combination
   * impossible to express — R-Alt + 8 is two clicks, and the first one landed
   * on the board before the second could happen. It stages instead, and Apply
   * is what reaches the device. Seeded from the current binding when a key is
   * picked, so the same highlight that says "these are the keys you are
   * choosing" also answers "what is bound here now".
   */
  const [staged, setStaged] = useState<RemapPick | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  /**
   * Escape, or a click anywhere off the board, drops the selected key.
   *
   * The assign panel below stays mounted either way (see `panel-inert`), so a
   * selection left behind is not obviously live — it just quietly decides
   * which key the next button press rewrites.
   *
   * Only while this tab is on screen — it stays mounted behind every other
   * tab, and an Escape or a click on Home is not about this board — and never
   * for a click that navigates: dropping the key there also dropped what was
   * staged for it, before the leave prompt could ask (NAVIGATION_SURFACES).
   */
  useEffect(() => {
    if (!onScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSel(null);
    };
    const onDown = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || el.closest('.kbkey, .kbmap, .keeps-selection, [role="dialog"]')) return;
      if (el.closest(NAVIGATION_SURFACES)) return;
      setSel(null);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onDown);
    };
  }, [onScreen]);

  // Reads the CURRENT device state for whichever layer is active — the base
  // layer previously had no read at all (readFnLayer always returned {}, and
  // nothing backed the base layer), so remapped keys showed blank on every
  // app start. `readKeyBindings` returns null only when the device didn't
  // answer; hard-wired Fn slots are flagged `locked` by the driver from the
  // vendor's own factory-default table, regardless of what the live read
  // shows (see KB_FN_DEFAULT_SLOTS).
  const {
    data: bindings,
    loading,
    firstLoad,
    reload,
  } = useDeviceData<Record<number, KeyBinding> | null>(
    device.id,
    (id) => sd.readKeyBindings(id, layer),
    null,
    [layer],
    `keyBindings:${layer}`,
  );

  const byRowCol = useMemo(() => {
    const m = new Map<string, KeyLayoutEntry>();
    for (const k of layout ?? []) m.set(`${k.row}:${k.col}`, k);
    return m;
  }, [layout]);

  const selSlot = useMemo(() => slotOf(layout, sel ?? { row: -1, col: -1 }), [sel, layout]);
  const selEntry = sel ? byRowCol.get(`${sel.row}:${sel.col}`) : undefined;
  const selBinding = selSlot !== null ? bindings?.[selSlot] : undefined;
  const selFactory = factoryBinding(selEntry, layer, selSlot);
  const selReset = resetCodeOf(selFactory);
  const selRemapped = isRemapped(selBinding, selEntry, layer, selSlot);
  /** What Reset asks, which is not what the board's colours ask — clearing an
   *  Fn binding leaves a key that does nothing AND differs from factory. */
  const selChanged = differsFromFactory(selBinding, selEntry, layer, selSlot);
  /** What the selected key currently sends, for seeding the picker. */
  const bound = useMemo(() => pickOf(selBinding?.raw), [selBinding]);
  const pick = staged ?? bound;
  const dirty = staged !== null && pickAction(staged) !== pickAction(bound);

  // A different key is a different question: drop whatever was staged for the
  // last one rather than carrying it across.
  const selKeyId = sel ? `${sel.row}:${sel.col}` : null;
  useEffect(() => setStaged(null), [selKeyId, layer]);

  /** One picker click — see `togglePick` for how a combination is built and
   *  how a media key replaces it. */
  const toggleUsage = (code: string) => setStaged(togglePick(pick, code));

  const applyStaged = () => {
    if (!dirty) return;
    void assign(pickAction(pick)).then(() => setStaged(null));
  };

  /** The Fn key itself is reserved like any other firmware-owned key — it was
   *  a third colour and a third legend row saying only "The Fn key itself",
   *  which is what the keycap already says. */
  const isFnKey = (k: { label: string }) =>
    layer === 'fn' && (k.label === 'FN' || k.label === 'Fn');

  /**
   * Reserved = the board's own behaviour, with nothing to assign.
   *
   * The driver decides this per quad against qmk.top's assignable-action list
   * (see `locked` in shared/keyboard-fn-codes.ts). It is not "type 10 and 13":
   * lighting mode and brightness +/- ARE in that picker and are ordinary
   * bindings, while lighting speed, preset and sub-mode are not, and neither
   * are the firmware functions on Esc/A/S/Win. Both rules the app tried to
   * derive instead of reading the list got a different third of the board
   * wrong.
   */
  const isReserved = (k: KeyLayoutEntry) => {
    if (isFnKey(k)) return true;
    if (layer !== 'fn') return false;
    const slot = slotOf(layout, k);
    return slot !== null && !!bindings?.[slot]?.locked;
  };

  const locked = !!sel && !!selEntry && isReserved(selEntry);

  /**
   * Type the remap instead of clicking it.
   *
   * Holding Right Alt and pressing 0 is how you would describe the binding out
   * loud, and the picker is 90 buttons. Only while a key is selected and the
   * panel is live, and every key is swallowed while it is: this is a keyboard
   * configurator, so a keystroke meant for the remap must not also reach the
   * app underneath. Escape still clears the selection (it is the one key that
   * means something to the tab). Only while this tab is the one on screen: it
   * stays mounted when you switch away, selection and all, and typing
   * elsewhere must not stage a remap here.
   *
   * The modifiers are the ones physically held, tracked by their own key
   * codes (see `heldModifiers`). Reading them off the browser's flags gave
   * their side by the location of the key being TYPED — the 8, not the Alt —
   * so Right Alt + 8 always came out as Left Alt + 8; and on Linux an AltGr
   * layout reports AltGr as no Alt at all, so it came out as a plain 8.
   */
  useEffect(() => {
    if (!sel || selSlot === null || locked || !onScreen) return;
    const held = heldModifiers();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      // A dialog over the board (the leave prompt, Reset all) owns its keys:
      // Enter there answers it, and must not be staged as the remap.
      if (
        el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.isContentEditable ||
          el.closest('[role="dialog"]'))
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      held.track(e);
      if (e.type !== 'keydown' || e.repeat) return;
      const own = hidUsageForBrowserCode(e.code);
      const main = own === null ? null : parseInt(own, 16);
      const mods = held.usages(e);
      // A bare modifier press IS a binding — Fn+2 really is just R-Alt.
      const all = main !== null && !mods.includes(main) ? [...mods, main] : mods;
      if (!all.length) return;
      setStaged({ usages: all.slice(0, COMBO_MAX), quad: null });
    };
    const onBlur = () => held.clear();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [sel, selSlot, locked, onScreen]);

  /** The selected key's colour ON THE BOARD, so the cap in the title is the
   *  same object you clicked rather than a picture of a generic key. */
  const selCapColor = !selEntry
    ? undefined
    : isReserved(selEntry)
      ? 'var(--red)'
      : selRemapped ||
          (layer === 'fn' &&
            selBinding &&
            !selBinding.locked &&
            FN_BOUND_KINDS.has(selBinding.kind))
        ? 'var(--kbkey-remap)'
        : undefined;

  /** "Reserved", plus what the firmware actually does with it when that is
   *  known. Nothing about why it cannot be reassigned: the key refuses to be
   *  selected for assignment, which says it better than a paragraph does. */
  const reservedText = (label?: string) =>
    label ? `${t('remap.reserved')} — ${label}` : t('remap.reserved');

  /** Resolves whether the write landed. */
  const assign = async (
    code: string,
    label = layer === 'fn' ? t('remap.write.fn') : t('remap.write.base'),
  ): Promise<boolean> => {
    if (selSlot === null) return false;
    const r = await run(label, () => sd.setKeyRemap(device.id, layer, selSlot, code));
    // Re-read so the new binding shows on the board immediately instead of
    // only after the pane remounts. This IS the verification — the driver
    // deliberately does no read-back of its own (see setKeyRemap).
    if (r.ok) reload();
    return r.ok;
  };

  /**
   * A staged pick is lost by leaving this tab, its layer or the device's tab,
   * so those ask first (state/leaveGuard.ts). Named the way the panel says it:
   * the key by what it types on the base layer, the pick by what it will send.
   */
  usePendingChange(device.id, {
    dirty: dirty && !locked,
    label: () => {
      const base = factoryCode(selEntry);
      const key = base ? keyNameForCode(base) : (selEntry?.label ?? '');
      const action =
        pick.quad !== null
          ? quadLabel(quadBytes(pick.quad), t)
          : pick.usages.length
            ? pick.usages.map((u) => keyNameForCode(u.toString(16))).join(' + ')
            : t('remap.staged.none');
      return t(layer === 'fn' ? 'leave.what.remapFn' : 'leave.what.remap', { key, action });
    },
    commit: async () => {
      const ok = await assign(pickAction(pick));
      if (ok) setStaged(null);
      return ok;
    },
  });

  /** Put one key back to whatever the factory layout says it sends — which on
   *  the Fn layer is usually "nothing", i.e. usage 0. */
  const resetKey = () => {
    if (selReset === null) return;
    setStaged(null);
    void assign(selReset, t('remap.write.resetKey'));
  };

  /** Clear whatever is bound here — the Fn layer's "Reset remap". */
  const clearKey = () => {
    setStaged(null);
    void assign(
      KEY_DISABLED_CODE,
      layer === 'fn' ? t('remap.write.clearFn') : t('remap.write.disable'),
    );
  };

  /**
   * Put every remapped key on this layer back to factory.
   *
   * Only the slots that actually differ are written — the board has 79 keys
   * and each write is a separate feature report on an endpoint that wedges
   * under sustained traffic, so rewriting all of them to say "no change" is
   * exactly the traffic to avoid.
   */
  const resetAll = async () => {
    setConfirmResetAll(false);
    const targets = (layout ?? []).filter((k) => {
      const slot = slotOf(layout, k);
      return slot !== null && differsFromFactory(bindings?.[slot], k, layer, slot);
    });
    if (!targets.length) return;
    const label =
      targets.length === 1
        ? t('remap.write.resetOne')
        : t('remap.write.resetMany', { n: targets.length });
    await run(label, async () => {
      let last = { ok: true, verified: 'unverified' as const };
      for (const k of targets) {
        const slot = slotOf(layout, k);
        const factory = resetCodeOf(factoryBinding(k, layer, slot));
        if (slot === null || factory === null) continue;
        const r = await sd.setKeyRemap(device.id, layer, slot, factory);
        if (!r.ok) return r;
        last = { ok: r.ok, verified: 'unverified' };
      }
      return last;
    });
    reload();
  };

  /** Bound, and still exactly what the board shipped with. */
  const factoryCount = useMemo(() => {
    if (!bindings || layer !== 'fn') return 0;
    return (layout ?? []).filter((k) => {
      const slot = slotOf(layout, k);
      if (slot === null || isReserved(k)) return false;
      const b = bindings[slot];
      if (!b || b.locked || !FN_BOUND_KINDS.has(b.kind)) return false;
      return !differsFromFactory(b, k, layer, slot);
    }).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindings, layout, layer]);

  const changedCount = useMemo(() => {
    if (!bindings) return 0;
    return (layout ?? []).filter((k) => {
      const slot = slotOf(layout, k);
      return slot !== null && differsFromFactory(bindings[slot], k, layer, slot);
    }).length;
  }, [bindings, layout, layer]);

  /**
   * What this key does now — the label the driver decoded from the live quad,
   * falling back to the plain usage.
   *
   * The Fn layer used to show this ONLY for keys the app had decided were
   * "remapped", which meant every media key, brightness key and firmware
   * shortcut the board actually ships with drew as a blank, unmapped cap:
   * Fn+F8 pauses music and the board said nothing was bound to it. What a key
   * does is worth showing whether or not anyone changed it.
   *
   * The driver decodes `label` in English; a media, launcher or lighting
   * binding is named again from its quad (`quadLabel`) in the app's language.
   */
  const bindingLabel = (b: KeyBinding | undefined): string | undefined => {
    if (!b || b.kind === 'unused') return undefined;
    if (b.label) return quadLabel(b.raw, t);
    return b.code ? keyNameForCode(b.code) : undefined;
  };

  /** The same thing at keycap size — see KeyBinding.shortLabel. A 1u cap fits
   *  about six characters, and "Screen brightness -" rendered as "Screen…" on
   *  every key it applied to. */
  const capLabel = (b: KeyBinding | undefined): string | undefined =>
    b?.shortLabel ?? bindingLabel(b);

  return (
    <div>
      <Panel title={t('remap.board')}>
        <ArtAnchor mode="keyboard" className="art-keyboard-anchor" measureRef={boardRef}>
          <KeyboardMap
            ref={boardRef}
            layout={layout}
            selected={sel}
            onSelect={(k) => setSel(k)}
            // A key is painted when it DOES something, not only when it has
            // been changed.
            //
            // Colouring only the changed keys was right for the base layer and
            // wrong for the Fn layer, where the keycap legend says nothing
            // about what Fn+that key does. Half the bound Fn keys — every media
            // and brightness key still on its factory value, every lighting
            // control — drew as blank keycaps that produced a tooltip when you
            // hovered them, which is the worst of both: the board looked empty
            // and the information was one hover away, one key at a time.
            //
            // `--kbkey-remap` rather than `--accent`: under several palettes
            // (grey-brown, grey, black) the accent IS a near-neutral, so
            // "remapped" and "ordinary key" came out the same colour.
            accent={(k) => {
              if (isReserved(k)) return 'var(--red)';
              const slot = slotOf(layout, k);
              if (slot === null) return undefined;
              const b = bindings?.[slot];
              if (isRemapped(b, k, layer, slot)) return 'var(--kbkey-remap)';
              // On the Fn layer a key that is BOUND is worth painting even when
              // it still holds its factory value — the keycap legend says
              // nothing about what Fn+it does. A lighting control counts as
              // bound: LEDMODELOOP and LEDBIRINC/DEC are assignable bindings
              // like any other, not something the board reserves.
              //
              // Its OWN colour, though. Sharing one with "remapped" meant a
              // board nobody had touched looked entirely reconfigured, and the
              // one thing the colour is for — telling your changes from the
              // board's — could not be read off it at all.
              if (layer !== 'fn' || !b || b.locked) return undefined;
              return FN_BOUND_KINDS.has(b.kind) ? 'var(--kbkey-factory)' : undefined;
            }}
            // Hover text for the whole key, not a corner glyph — see
            // KeyboardMap's `tip`. An ordinary key gets none: there is nothing
            // to say about it that the keycap does not already say.
            tip={(k) => {
              if (isFnKey(k)) return t('remap.reserved');
              const slot = slotOf(layout, k);
              const b = slot !== null ? bindings?.[slot] : undefined;
              if (isReserved(k)) return reservedText(bindingLabel(b));
              const what = bindingLabel(b);
              if (isRemapped(b, k, layer, slot)) return `→ ${what ?? t('remap.nothing')}`;
              // On the Fn layer the keycap legend is the BASE key's, so what
              // Fn+that does is never visible without this. On the base layer
              // an unchanged key sends what its legend says and needs nothing.
              return layer === 'fn' ? what : undefined;
            }}
            cap={(k) => {
              const slot = slotOf(layout, k);
              const b = slot !== null ? bindings?.[slot] : undefined;
              const what = capLabel(b);
              if (!what) return null;
              // The base layer only chips a key that CHANGED — there the cap's
              // own legend already says what it sends. The Fn layer chips
              // everything bound, because the cap says nothing about it.
              const remapped = isRemapped(b, k, layer, slot);
              if (layer === 'base' && !remapped) return null;
              return (
                <span className={`kbkey-bind${remapped ? ' kbkey-bind-remapped' : ''}`}>
                  {what}
                </span>
              );
            }}
          />
        </ArtAnchor>
        <div className="kb-legend keeps-selection">
          <span className="kb-legend-item">
            <span className="kb-legend-swatch" style={{ background: 'var(--kbkey-remap)' }} />
            {t('remap.remapped')} {changedCount > 0 && `(${changedCount})`}
          </span>
          {/* The board's own shortcuts, unchanged — Fn+F11 is Volume -, Fn+\ is
              the lighting toggle. They were painted the same colour as a user
              remap, which made a stock board look entirely reconfigured; and
              they are the third of the layer that most wants naming, since the
              keycap legend says nothing about any of them. */}
          {layer === 'fn' && (
            <span className="kb-legend-item">
              <span className="kb-legend-swatch" style={{ background: 'var(--kbkey-factory)' }} />
              {t('remap.factory')} {factoryCount > 0 && `(${factoryCount})`}
            </span>
          )}
          <span className="kb-legend-item">
            <span className="kb-legend-swatch" style={{ background: 'var(--red)' }} />
            {t('remap.reserved')}
          </span>
          {/* The third state is a keycap with nothing on it, which is easy to
              read as "nothing to see here" rather than as a category. Named on
              both layers: on the Fn layer two thirds of the board is exactly
              that, and on the base layer it is what "this key still does what
              its legend says" looks like — which is a state, not an absence. */}
          <span className="kb-legend-item">
            <span className="kb-legend-swatch kb-legend-swatch-plain" />
            {t('remap.unbound')}
          </span>
          <Tooltip text={t('remap.resetAll.tip')}>
            <button
              className="btn kb-legend-end"
              disabled={changedCount === 0}
              onClick={() => setConfirmResetAll(true)}
            >
              <Icon name="restore" size={12} /> {t('remap.resetAll')}
            </button>
          </Tooltip>
        </div>
        {firstLoad && <Loading inline />}
        {!loading && bindings === null && (
          <p className="hint" style={{ marginTop: 8 }}>
            {t('remap.readFailed')}
          </p>
        )}
      </Panel>

      {/* Rendered whether or not a key is selected — a whole panel appearing
          and disappearing under the board made the tab feel unstable. With
          nothing selected it stays in place, dimmed and inert, and so does the
          picker inside it: a grid of greyed buttons says "pick a key and these
          become available", where an empty panel said nothing at all. */}
      <div className="keeps-selection">
        <Panel
          title={
            <span className="remap-title">
              {layer === 'fn' ? t('remap.assign.fn') : t('remap.assign.base')}
              {selEntry ? (
                <KeyCap label={selEntry.label} color={selCapColor} />
              ) : (
                <span className="remap-title-any">{t('remap.assign.empty')}</span>
              )}
            </span>
          }
          /* Every action on this key, on the heading's line: as rows they cost
             two lines under a heading holding one word and a keycap. Reset and
             Disable/Clear write at once; Apply and Cancel act on the staged
             pick — the divider keeps the two kinds apart. */
          actions={
            locked ? undefined : (
              <>
                <button
                  className="btn"
                  // `selChanged`, not `selRemapped`: clearing an Fn binding
                  // leaves a key the board paints as unbound but which still
                  // differs from factory, and that is exactly when someone
                  // wants the factory function back. Reset was greyed out on
                  // precisely the keys that needed it.
                  disabled={!selChanged || selReset === null}
                  onClick={resetKey}
                >
                  {t('remap.resetKey')}
                  {selFactory.kind === 'usage' ? ` (${keyNameForCode(selFactory.code)})` : ''}
                </button>
                <Tooltip text={layer === 'fn' ? t('remap.clear.tip') : t('remap.disable.tip')}>
                  <button
                    className={`btn ${layer === 'fn' ? '' : 'danger'}`}
                    disabled={!sel || selSlot === null || isUnbound(selBinding)}
                    onClick={clearKey}
                  >
                    {/* On the Fn layer nothing is being disabled — the key
                        itself still types what its cap says. What goes away
                        is the Fn binding, so that is what the button says. */}
                    {layer === 'fn' ? t('remap.clear') : t('remap.disable')}
                  </button>
                </Tooltip>
                <span className="panel-actions-sep" aria-hidden="true" />
                <button className="btn primary" disabled={!dirty} onClick={applyStaged}>
                  <Icon name="check" size={12} /> {t('remap.confirm.apply')}
                </button>
                <button className="btn" disabled={staged === null} onClick={() => setStaged(null)}>
                  {t('remap.confirm.cancel')}
                </button>
              </>
            )
          }
        >
          {locked ? (
            <p className="hint">{reservedText(bindingLabel(selBinding))}</p>
          ) : (
            <>
              {/* What the key does now. Its two direct actions (Reset to
                  default, and Disable / Clear remap) are on the heading line
                  with Apply and Cancel, so this row only states the result. */}
              <Row
                label={t('remap.thisKey')}
                hint={
                  !sel
                    ? t('remap.pickKey')
                    : bindingLabel(selBinding)
                      ? t('remap.sends', { name: bindingLabel(selBinding)! })
                      : selChanged
                        ? t('remap.sendsNothing')
                        : t('remap.unchanged')
                }
              >
                {null}
              </Row>

              {/* What the picker below is currently spelling out, and the one
                  control that sends it. Without this the picker was a row of
                  buttons that each wrote immediately, so a combination could
                  not be expressed at all: R-Alt + 8 is two choices, and the
                  first reached the board before the second could be made. */}
              <Row
                label={t('remap.staged')}
                hint={t(isMac ? 'remap.pick.hint.mac' : 'remap.pick.hint')}
              >
                <div className="remap-staged">
                  <span className="remap-staged-keys">
                    {pick.quad !== null ? (
                      <StagedQuad code={pick.quad} />
                    ) : pick.usages.length === 0 ? (
                      <span className="hint">{t('remap.staged.none')}</span>
                    ) : (
                      pick.usages.map((u, i) => (
                        <span key={u} className="remap-staged-key">
                          {i > 0 && <span className="remap-plus">+</span>}
                          <KeyCap
                            label={keyNameForCode(u.toString(16))}
                            face={usageFace(u, keyNameForCode(u.toString(16)))}
                            small
                          />
                        </span>
                      ))
                    )}
                  </span>
                </div>
              </Row>

              <KeyPicker
                // Lit because it is part of what this key sends — which, since
                // the picker is seeded from the current binding, is also "what
                // is bound here now". One state, answering both questions.
                isOn={(code) => pickHas(pick, code)}
                onPick={toggleUsage}
                groups={REMAP_GROUPS}
                disabled={!sel || selSlot === null}
              />
            </>
          )}
        </Panel>
      </div>

      {confirmResetAll && (
        <ConfirmDialog
          title={t('remap.confirm.title')}
          body={t(changedCount === 1 ? 'remap.confirm.body' : 'remap.confirm.body.plural', {
            n: String(changedCount),
          })}
          confirmLabel={t('remap.confirm.ok')}
          onResolve={(ok) => (ok ? void resetAll() : setConfirmResetAll(false))}
        />
      )}
    </div>
  );
}

/** A staged media or launcher key, drawn as the keycap its binding will show. */
function StagedQuad({ code }: { code: string }) {
  const t = useT();
  const raw = quadBytes(code);
  const d = decodeKeyQuad(raw);
  return (
    <span className="remap-staged-key">
      <KeyCap label={quadLabel(raw, t)} face={quadFace(code, d.short)} small />
    </span>
  );
}
