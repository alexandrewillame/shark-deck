import type { Dispatch, SetStateAction } from 'react';
import { Panel, Select } from '../../components/common';
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
        // push the library macro to a device slot first, then bind it
        await sd.pushMacroToDevice(device.id, m.macroId);
        const onboard = await sd.readMacros(device.id).catch(() => []);
        const wantName = macros.find((y) => y.id === m.macroId)?.name;
        const slot = wantName ? onboard.findIndex((x) => x.name === wantName) : -1;
        payload = { ...m, macroSlot: slot >= 0 ? slot : 0 };
      }
      return sd.setButtonMapping(device.id, i, payload);
    });
  };

  const chooseAction = (i: number, key: string) => {
    const def = BUTTON_ACTION_BY_KEY[key]!;
    const m: ButtonMapping = { actionKey: key, action: def.wire ?? 0 };
    if (def.children) m.param = def.children[0]!.value;
    if (def.fire) m.fire = { times: 3, interval: 50 };
    if (def.combo) m.combo = [];
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
              value={m?.macroId ?? ''}
              options={[
                { value: '', label: macros.length ? '—' : t('buttons.macro.none') },
                ...macros.map((mac) => ({ value: mac.id, label: mac.name })),
              ]}
              onChange={(v) => write(i, { ...m!, actionKey: 'macro', action: 0x06, macroId: v })}
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
                    write(i, { ...m!, combo: combo.filter((x) => x != null) });
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
    </Panel>
  );
}
