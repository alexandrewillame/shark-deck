import { useState, type Dispatch, type SetStateAction } from 'react';
import { ConfirmDialog, Panel, Select } from '../../components/common';
import {
  type TabProps,
  sd,
  useDeviceData,
  useAutoWrite,
  DevNote,
  ReadFailed,
  Loading,
} from '../common';
import { useT } from '../../state/i18n';
import {
  BUTTON_ACTIONS_TREE,
  BUTTON_ACTION_BY_KEY,
  V8_BUTTON_ACTION_KEYS,
} from '@shared/mouse-buttons';
import { ALL_KEYS } from '@shared/keys';
import { buttonActionAllowed } from '@shared/menuGates';
import type { ButtonMapping } from '@shared/types/mouse-settings';
import type { Macro } from '@shared/types/macros';
import { macroSlotOf } from '@shared/keyboard-macro';
import { isModifierUsage } from '@shared/keyboard-fn-codes';
import { holdsMacro, pushSlotFor } from '../../components/macro/macroUtils';

/**
 * A row-per-button table (# / Button / Action / Options) — replaces the old
 * stacked "Button N" + a second "Action" row per button, which read as two
 * settings when there's really one action plus its inline sub-options.
 * `active`/`onActive` are lifted up into ButtonsTab, which mirrors them into
 * the store (`buttonBadgeActive`) so PersistentDeviceArt's numbered badges —
 * drawn directly on the one travelling mouse photo, not in this pane's own
 * layout — can hover-link back to the matching row here.
 */
export function ButtonsSection({
  device,
  active,
  onActive,
}: TabProps & { active: number | null; onActive: Dispatch<SetStateAction<number | null>> }) {
  const t = useT();
  const {
    data: map,
    setData,
    loading,
    firstLoad,
  } = useDeviceData<Record<number, ButtonMapping> | null>(
    device.id,
    sd.readButtons,
    null,
    [],
    'buttons',
  );
  const { data: macros } = useDeviceData(device.id, () => sd.listMacroLibrary(), []);
  // The macros the mouse holds, by slot (the Macros tab's read): which one a
  // button plays, and where a library macro given to a button goes.
  const hasMacros = device.capabilities.includes('macros');
  const { data: onboard, reload: reloadOnboard } = useDeviceData<Macro[]>(
    device.id,
    (id) => (hasMacros ? sd.readMacros(id) : Promise.resolve([])),
    [],
    [],
    'macros',
  );
  const slots = device.ui.macroLimits?.slots ?? 1;
  const { commit } = useAutoWrite(250, { deviceId: device.id });
  const count = device.ui.buttons ?? 6;
  const allow = device.ui.buttonActions?.length
    ? device.ui.buttonActions
    : (V8_BUTTON_ACTION_KEYS as readonly string[]);
  // ...and of those, only the ones whose feature this model has: a macro
  // button on a mouse with no macros, or a DPI-LED toggle on one with no DPI
  // LED, would be an option that does nothing (shared/menuGates.ts).
  const actions = BUTTON_ACTIONS_TREE.filter(
    (a) => allow.includes(a.key) && buttonActionAllowed(a.key, device),
  );

  // Asked before a one-macro mouse's macro changes under another button (giveMacro).
  const [oneMacro, setOneMacro] = useState<{ i: number; m: ButtonMapping; other: number } | null>(
    null,
  );

  // No heading of its own: the pane above is already titled "Buttons", and
  // the table names its columns.
  if (!loading && map === null) {
    return (
      <Panel>
        <ReadFailed />
      </Panel>
    );
  }
  const cur = map ?? {};

  const write = (i: number, m: ButtonMapping) => {
    setData({ ...cur, [i]: m });
    commit(t('buttons.n', { n: i + 1 }), async () => {
      // Build a fresh object for the wire write — never mutate `m`, which is
      // the same reference now held in React state (a back-dated `macroSlot`
      // would ride along on every later `{...m}` spread with no re-render).
      let payload = m;
      if (m.actionKey === 'macro' && m.macroId) {
        // The library macro goes to the slot already holding it, else the
        // first empty one, and the button plays the slot written (a mouse
        // with one macro: its one). Read afresh: the slot is written blind.
        const lib = macros.find((y) => y.id === m.macroId);
        const now = await sd.readMacros(device.id).catch(() => onboard);
        const slot =
          slots > 1 ? pushSlotFor(now, slots, (d) => !!lib && holdsMacro(d, lib, false)) : 0;
        if (slot === null)
          return { ok: false, verified: 'unverified', error: t('buttons.macro.full') };
        const pushed = await sd.pushMacroToDevice(
          device.id,
          m.macroId,
          slots > 1 ? slot : undefined,
        );
        if (!pushed.ok) return pushed;
        payload = { ...m, macroSlot: slot };
      }
      const r = await sd.setButtonMapping(device.id, i, payload);
      if (payload !== m) reloadOnboard();
      return r;
    });
  };

  /**
   * The macro a button plays, as the picker names it: the library macro the
   * mouse's macro in that slot is, else that macro itself (`onboard-<slot>`).
   */
  const playing = (m: ButtonMapping | undefined): string => {
    if (m?.actionKey !== 'macro') return '';
    if (m.macroId) return m.macroId;
    const dev = onboard.find((x) => macroSlotOf(x.id) === (m.macroSlot ?? 0));
    if (!dev) return '';
    return macros.find((x) => holdsMacro(dev, x, false))?.id ?? dev.id;
  };
  /** The mouse's macros with no copy in the library: offered as they are. */
  const unlisted = onboard.filter((d) => !macros.some((x) => holdsMacro(d, x, false)));
  const bindMacro = (i: number, m: ButtonMapping | undefined, v: string) => {
    const { macroId: _old, ...rest } = m ?? { actionKey: 'macro', action: 0x06 };
    const slot = macroSlotOf(v);
    // One the mouse already holds: bound where it is, nothing pushed.
    if (slot !== null)
      return giveMacro(i, { ...rest, actionKey: 'macro', action: 0x06, macroSlot: slot });
    giveMacro(i, { ...rest, actionKey: 'macro', action: 0x06, macroId: v });
  };

  /**
   * A mouse that holds one macro (the Beken mice: MacroLimits.slots 1) plays
   * it on every button given a macro, so a second button given a different one
   * changes what the first plays too. That is asked, not done silently.
   */
  const giveMacro = (i: number, m: ButtonMapping) => {
    if (slots === 1 && m.macroId) {
      const other = Object.entries(cur).find(
        ([j, x]) => Number(j) !== i && playing(x) !== '' && playing(x) !== m.macroId,
      );
      if (other) return setOneMacro({ i, m, other: Number(other[0]) });
    }
    write(i, m);
  };

  // A shortcut with no key yet is nothing a mouse can take (the Beken mice
  // refused it with an error the moment "Combo key" was chosen): it is only
  // shown, and goes out once a key is in it. On a mouse whose shortcut is one
  // key with modifiers, a modifier picked first waits for that key too: Ctrl
  // alone was refused the same way, before the key could be picked.
  const writeCombo = (i: number, m: ButtonMapping) => {
    const keys = m.combo ?? [];
    const ready = device.ui.comboOneKey ? keys.some((k) => !isModifierUsage(k)) : keys.length > 0;
    return ready ? write(i, m) : setData({ ...cur, [i]: m });
  };

  const chooseAction = (i: number, key: string) => {
    const def = BUTTON_ACTION_BY_KEY[key]!;
    const m: ButtonMapping = { actionKey: key, action: def.wire ?? 0 };
    if (def.children) m.param = def.children[0]!.value;
    // A Beken mouse's rapid fire has no count or interval (DeviceUi.fireWhileHeld).
    if (def.fire && !device.ui.fireWhileHeld) m.fire = { times: 3, interval: 50 };
    if (def.combo) return writeCombo(i, { ...m, combo: [] });
    write(i, m);
  };

  const buttonMap = device.ui.buttonMap;

  const rows = Array.from({ length: count }, (_, i) => {
    const m = cur[i];
    const key = m?.actionKey ?? 'button';
    const def = BUTTON_ACTION_BY_KEY[key];
    const entry = buttonMap?.[i];
    // `locked` used to re-derive from the label string, which broke the
    // moment a buttonMap existed (button 1 became reassignable) — now reads
    // the catalog's own flag, falling back to "index 0" only when the
    // model has no buttonMap at all.
    const locked = entry?.locked ?? (i === 0 && !buttonMap);
    const physicalLabel = entry?.labelKey ? t(entry.labelKey as never) : entry?.label;
    return (
      <div
        key={i}
        className={`btn-row ${active === i ? 'is-active' : ''}`}
        onMouseEnter={() => onActive(i)}
        onMouseLeave={() => onActive((a) => (a === i ? null : a))}
      >
        <span className="btn-row-n mono">{i + 1}</span>
        <span className="btn-row-name">{physicalLabel ?? t('buttons.n', { n: i + 1 })}</span>
        <span className="btn-row-action">
          {locked ? (
            <span className="hint">{t('buttons.leftLocked')}</span>
          ) : (
            <Select
              value={key}
              options={actions.map((a) => ({
                value: a.key,
                label: t(a.labelKey as never) + (a.wire === null ? ' *' : ''),
              }))}
              onChange={(v) => chooseAction(i, v)}
            />
          )}
        </span>
        <span className="btn-row-options">
          {!locked && def?.children && !def.multimedia && (
            <Select
              value={String(m?.param ?? def.children[0]!.value)}
              options={def.children.map((c) => ({ value: c.value, label: c.labelEn }))}
              onChange={(v) => write(i, { ...m!, param: Number(v) })}
            />
          )}
          {!locked && def?.multimedia && (
            <Select
              value={String(m?.multimedia ?? def.children![0]!.value)}
              options={def.children!.map((c) => ({ value: c.value, label: c.labelEn }))}
              onChange={(v) => write(i, { ...m!, multimedia: Number(v) })}
            />
          )}
          {!locked && def?.fire && m?.fire && (
            <span className="btn-row-fire">
              <label>
                {t('buttons.fire.times')}
                <input
                  type="number"
                  min={0}
                  max={3}
                  value={m.fire.times}
                  onChange={(e) =>
                    write(i, { ...m, fire: { ...m.fire!, times: Number(e.target.value) } })
                  }
                  style={{ width: 48 }}
                />
              </label>
              <label>
                {t('buttons.fire.interval')}
                <input
                  type="number"
                  min={10}
                  max={255}
                  value={m.fire.interval}
                  onChange={(e) =>
                    write(i, { ...m, fire: { ...m.fire!, interval: Number(e.target.value) } })
                  }
                  style={{ width: 56 }}
                />
              </label>
            </span>
          )}
          {!locked && def?.macro && (
            <Select
              value={playing(m)}
              options={[
                {
                  value: '',
                  label: macros.length || unlisted.length ? '—' : t('buttons.macro.none'),
                },
                ...macros.map((mac) => ({ value: mac.id, label: mac.name })),
                ...unlisted.map((d) => ({
                  value: d.id,
                  label: `${d.name} · ${t('macro.slot.used')}`,
                })),
              ]}
              onChange={(v) => bindMacro(i, m, v)}
            />
          )}
          {!locked && def?.combo && (
            <span className="btn-row-combo">
              {[0, 1, 2].map((slot) => (
                <Select
                  key={slot}
                  value={m?.combo?.[slot] ? m.combo[slot]!.toString(16) : ''}
                  options={[
                    { value: '', label: '—' },
                    ...ALL_KEYS.map((k) => ({ value: k.code, label: k.label })),
                  ]}
                  onChange={(v) => {
                    const combo = [...(m?.combo ?? [])];
                    if (v) combo[slot] = parseInt(v, 16);
                    else combo.splice(slot, 1);
                    writeCombo(i, { ...m!, combo: combo.filter((x) => x != null) });
                  }}
                />
              ))}
            </span>
          )}
        </span>
      </div>
    );
  });

  return (
    <Panel>
      {firstLoad && <Loading />}
      {!loading && (
        <div className="buttons-table">
          <div className="btn-row btn-row-head">
            <span className="btn-row-n">{t('buttons.col.n')}</span>
            <span className="btn-row-name">{t('buttons.col.button')}</span>
            <span className="btn-row-action">{t('buttons.sub')}</span>
            <span className="btn-row-options">{t('buttons.col.options')}</span>
          </div>
          {rows}
        </div>
      )}
      {!loading && actions.some((a) => a.wire === null) && (
        <DevNote style={{ marginTop: 8 }}>{t('buttons.unconfirmed')}</DevNote>
      )}
      {oneMacro && (
        <ConfirmDialog
          title={t('buttons.macro.oneSlot.title')}
          body={t('buttons.macro.oneSlot.body', {
            n: String(oneMacro.other + 1),
            name: macros.find((x) => x.id === oneMacro.m.macroId)?.name ?? '',
          })}
          confirmLabel={t('buttons.macro.oneSlot.ok')}
          onResolve={(ok) => {
            const pending = oneMacro;
            setOneMacro(null);
            if (ok) write(pending.i, pending.m);
          }}
        />
      )}
    </Panel>
  );
}
