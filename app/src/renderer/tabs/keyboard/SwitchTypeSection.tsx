import { useEffect, useMemo, useState } from 'react';
import type { LiveDevice } from '@shared/types/live';
import { switchChoices, switchColor, switchModel } from '@shared/keyboard-switches';
import { Panel, Row } from '../../components/common';
import { Icon } from '../../components/icons';
import { KeyboardMap, type KeyRef } from '../../components/KeyboardMap';
import { sd, useWrite } from '../common';
import { useT } from '../../state/i18n';
import { slotOf } from '../../keyLayout';

const keyId = (k: { row: number; col: number }) => `${k.row}:${k.col}`;

/**
 * Which magnetic switch is fitted in each key, and reassigning it after a swap.
 *
 * These boards convert a Hall reading into millimetres using a curve that
 * depends on the magnet, so a key with a different switch in it reports the
 * wrong depth until the board is told. That is what magnetism page 252 is for,
 * and nothing in the app read or wrote it.
 *
 * Modelled on qmk.top's own switch page, which is where the id space came
 * from: a fixed short list of the models that fit this board (not the whole
 * 127-model enum — see SWITCH_CHOICES_DEFAULT), each with the vendor's own
 * colour, and a board painted in those colours so a mixed build is readable
 * without clicking a single key. A stock R85HE is 79 yellow keys.
 *
 * **The honest state of this feature**: the page number, its width and the id
 * space are all taken from the vendor's own data, but the one Attack Shark
 * snapshot this repo has reads the page as all zeros. On qmk.top a stored 0
 * resolves to the model's own stock switch, so for this board that reads as
 * "all Outemu" rather than "unset" — but the app cannot tell that apart from
 * "this board ignores the page", so the driver diffs the read-back after every
 * write and the banner below says so. See shared/keyboard-switches.ts.
 */
export function SwitchTypeSection({ device }: { device: LiveDevice }) {
  const t = useT();
  const { run } = useWrite();
  const layout = device.ui.keyMatrix?.layout;
  const choices = useMemo(() => switchChoices(device.ui.supportedSwitches), [device.ui]);
  /** A stored 0 is "this model's stock switch", which is the first entry of the
   *  board's own list — not a separate "factory" pseudo-model. */
  const stockId = choices[0]?.id ?? 0;
  const [bySlot, setBySlot] = useState<Record<number, number> | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [pick, setPick] = useState<number>(stockId);

  const reload = () => {
    setLoading(true);
    sd.readSwitchTypes(device.id)
      .then(setBySlot)
      .catch(() => setBySlot(null))
      .finally(() => setLoading(false));
  };
  useEffect(reload, [device.id]);

  /** The id a slot's stored value actually means. */
  const idOf = (slot: number): number | undefined => {
    const raw = bySlot?.[slot];
    if (raw === undefined) return undefined;
    return raw === 0 ? stockId : raw;
  };

  const selectedSlots = useMemo(() => {
    if (!layout) return [];
    return layout
      .filter((k) => sel.has(keyId(k)))
      .map((k) => slotOf(layout, k))
      .filter((s): s is number => s !== null);
  }, [layout, sel]);

  const onSelect = (k: KeyRef, mods: { shift: boolean; ctrl: boolean }) =>
    setSel((prev) => {
      const id = keyId(k);
      if (!mods.shift && !mods.ctrl) return new Set([id]);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** The same three ways in as the Keys view: click, shift/ctrl-click, drag a
   *  box — plus the two buttons, which are the ones that are discoverable. */
  const selectAll = () => setSel(new Set((layout ?? []).map(keyId)));
  const selectNone = () => setSel(new Set());

  const assign = async (switchId: number) => {
    if (!selectedSlots.length) return;
    const r = await run(switchModel(switchId)?.name ?? `#${switchId}`, () =>
      sd.setSwitchTypes(
        device.id,
        selectedSlots.map((slot) => ({ slot, switchId })),
      ),
    );
    // Re-read either way: a mismatch is exactly the case worth showing.
    if (r.ok) reload();
  };

  /** Every model actually fitted, so the legend is what is ON the board rather
   *  than a repeat of the picker above it. */
  const inUse = useMemo(() => {
    const ids = new Set<number>();
    for (const slot of Object.keys(bySlot ?? {})) {
      const id = idOf(Number(slot));
      if (id !== undefined) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
  }, [bySlot, stockId]);

  return (
    <Panel title={t('act.sw.title')} className="panel-board-first">
      <p className="pill warn" style={{ marginBottom: 12, display: 'inline-block' }}>
        {t('act.sw.warn')}
      </p>
      {!loading && bySlot === null && <p className="hint">{t('act.sw.readFailed')}</p>}
      <div className="kb-toolbar">
        <span className="hint">{t('act.sw.selectHint')}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={selectAll}>
          <Icon name="marquee" size={12} /> {t('act.sel.all')}
        </button>
        <button className="btn" onClick={selectNone} disabled={sel.size === 0}>
          <Icon name="close" size={12} /> {t('act.sel.none')}
        </button>
        {sel.size > 0 && (
          <span className="hint">{t('act.sel.count', { n: String(sel.size) })}</span>
        )}
      </div>
      <KeyboardMap
        layout={layout}
        isSelected={(k) => sel.has(keyId(k))}
        onSelect={onSelect}
        marqueeFromKeys
        onMarquee={(keys, mods) =>
          setSel((prev) => {
            const ids = keys.map(keyId);
            return mods.shift || mods.ctrl ? new Set([...prev, ...ids]) : new Set(ids);
          })
        }
        // The WHOLE key, not an edge stripe. On this view the switch model is
        // the only thing the board is saying, so it should be readable at a
        // glance across 79 keys — a 3px line at the edge of each cap was not.
        // (The Keys view tints the whole cap too, with the key's GROUP colour;
        // the live-travel readout coexists with it in the gauge gutter rather
        // than in the cap.)
        //
        // Every key is tinted, including the ones still on the stock switch:
        // the point of the colour code is that the board reads as one colour
        // until something has been swapped into it.
        accent={(k) => {
          if (k.slot == null) return undefined;
          const id = idOf(k.slot);
          return id === undefined ? undefined : switchColor(id);
        }}
        tip={(k) => {
          if (k.slot == null) return undefined;
          const id = idOf(k.slot);
          return id === undefined ? undefined : (switchModel(id)?.name ?? `#${id}`);
        }}
      />
      {inUse.length > 0 && (
        <div className="kb-legend">
          {inUse.map((id) => (
            <span className="kb-legend-item" key={id}>
              <span className="kb-legend-swatch" style={{ background: switchColor(id) }} />
              {switchModel(id)?.name ?? `#${id}`}
            </span>
          ))}
        </div>
      )}
      {/* The picker IS the apply: qmk.top has no separate confirm step, and a
          two-control "choose then apply" only added a state where the dropdown
          disagreed with the board. Each model carries its own colour, so the
          choice and the thing it paints look the same. */}
      <Row label={t('act.sw.pick')} hint={t('act.sw.recalibrate')}>
        <div className="switch-picker">
          {choices.map((s) => (
            <button
              key={s.id}
              className={`switch-chip${s.id === pick ? ' sel' : ''}`}
              disabled={!selectedSlots.length}
              onClick={() => {
                setPick(s.id);
                void assign(s.id);
              }}
            >
              <span className="switch-chip-swatch" style={{ background: switchColor(s.id) }} />
              {s.name}
            </button>
          ))}
        </div>
      </Row>
      {!selectedSlots.length && <p className="hint">{t('act.sw.selectFirst')}</p>}
      {selectedSlots.length > 0 && (
        <p className="hint">
          {selectedSlots.length === 1
            ? t('act.sw.applyOne')
            : t('act.sw.apply', { n: String(selectedSlots.length) })}
        </p>
      )}
    </Panel>
  );
}
