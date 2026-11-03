import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveDevice } from '@shared/types/live';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { ProfileField, ProfileSnapshots } from '@shared/types/profiles';
import type { MessageKey, TFunc } from '@shared/i18n';
import { ConfirmDialog } from './common';
import { Icon } from './icons';
import {
  blocksByKey,
  diffField,
  keyNames,
  type FieldDiff,
  type KeyBlock,
  type KeyNames,
} from './profileDiff';
import { dropDeviceCache, sd, useDeviceBusy, useWrite } from '../tabs/common';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { slotLabel } from '../state/ui';

/**
 * What two profile slots hold, side by side, down to the individual key.
 *
 * Shaped as a two-way diff rather than an N-column matrix, which is what the
 * first version was and what made it unreadable: a cell showed a collection's
 * LENGTH, so four profiles differing on twelve keys read as "79 · 79 · 79 · 79".
 * A difference only exists BETWEEN two specific profiles, which is what lets a
 * row say "W · Actuation | 1.20 mm | 2.00 mm" instead of a count.
 *
 * Detail rows are rows of the SAME table, not a nested one. A nested table has
 * its own column widths and will not line up with the header it sits under, so
 * the values in the Desktop column stopped being under the word "Desktop".
 *
 * The data comes from `snapshotProfiles`, which reads EVERY slot in one sweep
 * (the device exposes only the slot it is on), so changing which pair is shown
 * — and counting how far apart every other pair is, for the pickers — costs
 * nothing once it has run.
 *
 * A device whose slot holds a single field — a keyboard, where that is the
 * actuation settings (see `profileFieldsFor`) — gets a flat table: one block
 * per key, no field header to open, and a copy column between the two
 * profiles that moves every setting of that one key either way.
 */
export function ProfileCompare({ device, onClose }: { device: LiveDevice; onClose: () => void }) {
  const t = useT();
  const { whileBusy } = useDeviceBusy(device.id);
  const { run } = useWrite();
  const bumpConfigEpoch = useStore((s) => s.bumpConfigEpoch);
  /**
   * Set once a copy has landed on the slot the board is ON. The pane behind
   * this dialog read that slot before the copy and still holds what it read,
   * and its next edit would diff against those stale values — skipping pages
   * it believes unchanged. Closing re-reads it. Safe to do from here: this
   * dialog is rendered outside the pane's remounting wrapper (DeviceConfig).
   */
  const touchedActive = useRef(false);
  const close = () => {
    if (touchedActive.current) {
      dropDeviceCache(device.id);
      bumpConfigEpoch(device.id);
    }
    onClose();
  };
  const [snap, setSnap] = useState<ProfileSnapshots | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ slot: number; total: number } | null>(null);
  /** Collapsed fields. Empty = everything open, which is the default: the
   *  detail IS the answer, and a dialog of closed rows makes you click to find
   *  out whether there was anything worth opening. */
  const [collapsed, setCollapsed] = useState<Set<ProfileField>>(new Set());
  const [confirm, setConfirm] = useState<{
    from: number;
    to: number;
    field?: ProfileField;
  } | null>(null);

  const count = device.ui.profileCount || 4;
  const [left, setLeft] = useState(device.activeProfile ?? 1);
  const [right, setRight] = useState(((device.activeProfile ?? 1) % count) + 1);

  // The sweep is one long call, so its only sign of life is this. Subscribed
  // before it starts, and filtered by device: two config windows can be open.
  useEffect(
    () =>
      sd.on('profiles:progress', (p) => {
        if (p.deviceId === device.id) setProgress({ slot: p.slot, total: p.total });
      }),
    [device.id],
  );

  const load = () =>
    whileBusy(t('profile.compare.reading'), () => sd.snapshotProfiles(device.id))
      .then((s) => {
        setSnap(s);
        setError(null);
      })
      .catch((e: unknown) => setError(String((e as Error)?.message ?? e)))
      .finally(() => setProgress(null));

  // The sweep starts as soon as the dialog opens: it IS the dialog's content,
  // so an "are you sure" in front of it would only be a second click on the
  // way to the same place. The button's tooltip says the device will switch.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id]);

  // Through a ref, so the listener always closes with the current `close`
  // without being re-attached on every render.
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !confirm && closeRef.current();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [confirm]);

  const doCopy = async (from: number, to: number, field?: ProfileField) => {
    setConfirm(null);
    await whileBusy(t('profile.compare.writing'), () =>
      run(slotLabel(device, to, t), () =>
        sd.copyProfile(device.id, from, to, field ? [field] : undefined),
      ),
    );
    if (to === device.activeProfile) touchedActive.current = true;
    // Re-read rather than patching the table: a copy can partly fail (a field
    // with no single-shot writer is reported, not written), so the only honest
    // "what is on the board now" is another look at the board.
    await load();
  };

  /**
   * Every setting of one key, from one profile onto the other.
   *
   * The whole key goes, not only the settings that differ: "make Esc on
   * Gaming what it is on Desktop" is the request, and a partial copy would
   * leave it neither. The values come from the sweep this table was drawn
   * from — the dialog is modal and busy-locked, so they cannot have moved —
   * and the destination's own values ride along as `previous`, so only the
   * pages that differ are sent.
   */
  const copyKey = async (block: KeyBlock, from: number, to: number) => {
    if (!snap) return;
    const keysOf = (slot: number) =>
      (snap.slots.find((s) => s.slot === slot)?.values.magnetic ?? null) as
        MagneticKeySettings[] | null;
    const at = (list: MagneticKeySettings[] | null, id: string) =>
      list?.find((k) => `${k.row},${k.col}` === id);
    const src = keysOf(from);
    const dst = keysOf(to);
    const k = at(src, block.keyId);
    if (!k) return;
    const keys = [k];
    // A Snap-tap key is half of a pair. Copied alone, the destination would
    // hold a key naming a partner that does not name it back.
    const partner =
      k.mode === 'snap' && k.socdPartner
        ? at(src, `${k.socdPartner.row},${k.socdPartner.col}`)
        : undefined;
    if (partner) keys.push(partner);
    const prev = keys.map((x) => at(dst, `${x.row},${x.col}`));
    const previous = prev.every(Boolean) ? (prev as MagneticKeySettings[]) : undefined;
    await whileBusy(t('profile.compare.writing'), () =>
      run(`${block.name} → ${slotLabel(device, to, t)}`, () =>
        sd.setMagneticKeysOnProfile(device.id, to, keys, previous),
      ),
    );
    if (to === device.activeProfile) touchedActive.current = true;
    await load();
  };

  const names = useMemo(() => keyNames(device.ui.keyMatrix?.layout), [device.ui.keyMatrix]);
  const diffs = useMemo(
    () => (snap ? diffPair(snap, left, right, names, t) : []),
    [snap, left, right, names, t],
  );

  const changed = diffs.filter((d) => !d.same && !d.unread);
  /** One field means nothing to group by: list its keys directly. */
  const flat = !!snap && snap.fields.length === 1;
  /** …and when that field is actuation, each key can be copied on its own. */
  const perKeyCopy = flat && snap!.fields[0] === 'magnetic';
  const blocks = useMemo(
    () => (flat && changed[0] ? blocksByKey(changed[0].rows) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [flat, diffs],
  );
  const fieldName = (f: ProfileField) => t(`pf.${f}` as MessageKey);
  const leftName = slotLabel(device, left, t);
  const rightName = slotLabel(device, right, t);

  /** The one-line answer for a row, in the caller's language. */
  const headline = (d: FieldDiff): string => {
    const n = { n: d.changed, total: d.total };
    switch (d.unit) {
      case 'value':
        return `${d.a} → ${d.b}`;
      case 'key':
        return t('profile.compare.diffKeys', n);
      case 'button':
        return t('profile.compare.diffButtons', n);
      case 'stage':
        return t('profile.compare.diffStages', n);
      default:
        return t('profile.compare.diffSettings', n);
    }
  };

  /**
   * Each option carries how far that profile is from the one selected in the
   * OTHER picker, so "which should I compare against" is answerable before
   * committing to the comparison. Free: every slot was read in the same sweep.
   */
  const optionsAgainst = useMemo(() => {
    // Every (candidate, other) distance, computed once per sweep rather than
    // per render: each one is a full field-by-field diff, and the two pickers
    // between them ask for 2N of them every time anything in the dialog
    // changes.
    const note = (n: number, other: number) => {
      if (!snap || n === other) return null;
      const d = distance(snap, n, other, names);
      return d.keyTotal > 0
        ? t('profile.compare.optKeys', { n: d.keys, total: d.keyTotal })
        : d.settings > 0
          ? t('profile.compare.optSettings', { n: d.settings })
          : t('profile.compare.optIdentical');
    };
    // The currently-SELECTED option keeps its note, which means a collapsed
    // picker also shows how far the two are apart. That is deliberate: the
    // number is the point, and hiding it until the menu opens would make the
    // resting state say less than it can.
    return (other: number) =>
      Array.from({ length: count }, (_, i) => i + 1).map((n) => {
        const label = slotLabel(device, n, t);
        // Except against itself: a profile is not a distance from itself.
        const extra = note(n, other);
        return { value: n, label: extra ? `${label} — ${extra}` : label };
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, names, count, device, t]);

  return createPortal(
    <div className="modal-scrim" onClick={close}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h4>{t('profile.compare')}</h4>

        {/* Which two, always visible — it is the thing every row below is
            relative to, and what makes a copy direction unambiguous. */}
        <div className="cmp-pair">
          <span className="hint">{t('profile.compare.between')}</span>
          <select
            className="cmp-pick"
            value={left}
            aria-label={t('profile.compare.between')}
            onChange={(e) => setLeft(Number(e.target.value))}
          >
            {optionsAgainst(right).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="hint">{t('profile.compare.with')}</span>
          <select
            className="cmp-pick"
            value={right}
            aria-label={t('profile.compare.with')}
            onChange={(e) => setRight(Number(e.target.value))}
          >
            {optionsAgainst(left).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="cmp-error">{error}</p>}
        {!snap && !error && (
          <p className="cmp-reading">
            {progress
              ? t('profile.compare.readingSlot', {
                  name: slotLabel(device, progress.slot, t),
                  n: progress.slot,
                  total: progress.total,
                })
              : `${t('profile.compare.reading')}…`}
          </p>
        )}
        {snap && !snap.fields.length && <p>{t('profile.compare.empty')}</p>}

        {snap && !!snap.fields.length && left === right && (
          <p className="cmp-same">{t('profile.compare.allSame')}</p>
        )}

        {snap && !!snap.fields.length && left !== right && (
          <>
            <p className="cmp-summary">
              {flat && diffs[0]
                ? diffs[0].same
                  ? t('profile.compare.allSame')
                  : headline(diffs[0])
                : t('profile.compare.summary', { n: changed.length, total: diffs.length })}
            </p>
            {/* The SCROLLPORT is this wrapper, not the table. Putting
                `overflow` on the table itself needs `display: block` on it and
                `display: table` back on thead/tbody, which stops it being a
                table for sizing and lets the notes below overlap it.
                Not drawn at all when nothing differs: a header with no rows
                under it read as a table that failed to load. */}
            <div className="cmp-scroll" hidden={!changed.length}>
              <table
                className={['cmp-table', flat && 'cmp-flat', perKeyCopy && 'has-copy']
                  .filter(Boolean)
                  .join(' ')}
              >
                <colgroup>
                  <col className="cmp-c-setting" />
                  <col />
                  {perKeyCopy && <col className="cmp-c-copy" />}
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>{flat ? t('profile.compare.colKey') : t('profile.compare.colSetting')}</th>
                    <th className="cmp-a">{leftName}</th>
                    {perKeyCopy && (
                      <th className="cmp-copy-head" aria-label={t('profile.compare.colCopy')} />
                    )}
                    <th className="cmp-b">{rightName}</th>
                  </tr>
                </thead>
                {flat &&
                  blocks.map((b) => (
                    // One tbody per key: the rows of a key read as one block,
                    // and the copy cell can span exactly them.
                    <tbody key={b.keyId} className="cmp-keyblock">
                      {b.rows.map((r, i) => (
                        <tr key={`${b.keyId}-${r.setting ?? ''}-${i}`} className="cmp-detail">
                          <th scope="row">
                            {/* The key is named once per block; later rows keep
                                the name for a screen reader only, so each row
                                still reads as "W Release". */}
                            <span className={i === 0 ? 'cmp-key' : 'cmp-key cmp-key-repeat'}>
                              {r.label}
                            </span>
                            {r.setting && <span className="cmp-sub"> {r.setting}</span>}
                          </th>
                          <td className="cmp-a">
                            <Val text={r.a} color={r.aColor} isDefault={r.aDefault} t={t} />
                          </td>
                          {perKeyCopy && i === 0 && (
                            <td className="cmp-copy" rowSpan={b.rows.length}>
                              {/* Each arrow on the side of the profile it copies
                                  TO: left copies into the left profile, right
                                  into the right. They were the other way round,
                                  so the arrow nearest a profile was the one that
                                  took from it. */}
                              <button
                                type="button"
                                className="btn-icon"
                                title={t('profile.compare.copyFieldTo', {
                                  field: b.name,
                                  from: rightName,
                                  to: leftName,
                                })}
                                aria-label={t('profile.compare.copyFieldTo', {
                                  field: b.name,
                                  from: rightName,
                                  to: leftName,
                                })}
                                onClick={() => void copyKey(b, right, left)}
                              >
                                <Icon name="copyLeft" size={14} />
                              </button>
                              <button
                                type="button"
                                className="btn-icon"
                                title={t('profile.compare.copyFieldTo', {
                                  field: b.name,
                                  from: leftName,
                                  to: rightName,
                                })}
                                aria-label={t('profile.compare.copyFieldTo', {
                                  field: b.name,
                                  from: leftName,
                                  to: rightName,
                                })}
                                onClick={() => void copyKey(b, left, right)}
                              >
                                <Icon name="copyRight" size={14} />
                              </button>
                            </td>
                          )}
                          <td className="cmp-b">
                            <Val text={r.b} color={r.bColor} isDefault={r.bDefault} t={t} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                {!flat && (
                  <tbody>
                    {changed.map((d) => {
                      const open = !collapsed.has(d.field);
                      const canExpand = d.rows.length > 0;
                      return [
                        <tr key={d.field} className="cmp-row">
                          <th scope="row">
                            {canExpand ? (
                              <button
                                type="button"
                                className="cmp-disclose"
                                aria-expanded={open}
                                aria-label={
                                  open ? t('profile.compare.collapse') : t('profile.compare.expand')
                                }
                                onClick={() =>
                                  setCollapsed((s) => {
                                    const next = new Set(s);
                                    if (open) next.add(d.field);
                                    else next.delete(d.field);
                                    return next;
                                  })
                                }
                              >
                                {/* One glyph, rotated — a disclosure triangle that
                                  turns is the convention, and it keeps the two
                                  states from drifting into two drawings. */}
                                <span className={`cmp-caret ${open ? 'is-open' : ''}`}>
                                  <Icon name="chevronRight" size={11} />
                                </span>
                                {fieldName(d.field)}
                              </button>
                            ) : (
                              <span className="cmp-nodisclose">{fieldName(d.field)}</span>
                            )}
                          </th>
                          {/* A scalar puts its two values under the two profile
                            columns, where they line up with the headers.
                            Anything with detail rows has no single value, so
                            its summary spans both and the detail carries the
                            per-key pairs. */}
                          {d.unit === 'value' ? (
                            <>
                              <td className="cmp-v cmp-a">{d.a}</td>
                              <td className="cmp-v cmp-b">{d.b}</td>
                            </>
                          ) : (
                            <td className="cmp-headline" colSpan={2}>
                              {headline(d)}
                            </td>
                          )}
                        </tr>,
                        ...(open
                          ? d.rows.map((r, i) => (
                              <tr
                                key={`${d.field}-${r.label}-${r.setting ?? ''}-${i}`}
                                className="cmp-detail"
                              >
                                {/* The key and the setting on it are different
                                  kinds of thing, so they are told apart by
                                  weight and colour rather than by a separator
                                  the eye has to parse. The space between them
                                  is real, so the row still reads as "D
                                  Actuation" to a screen reader. */}
                                <th scope="row">
                                  <span className="cmp-key">{r.label}</span>
                                  {r.setting && <span className="cmp-sub"> {r.setting}</span>}
                                </th>
                                <td className="cmp-a">
                                  <Val text={r.a} color={r.aColor} isDefault={r.aDefault} t={t} />
                                </td>
                                <td className="cmp-b">
                                  <Val text={r.b} color={r.bColor} isDefault={r.bDefault} t={t} />
                                </td>
                              </tr>
                            ))
                          : []),
                      ];
                    })}
                  </tbody>
                )}
                {/* "Copy all", under the column it copies TO — like the per-key
                    arrows, each points outward at its own side. In the table's
                    own footer, so it shares the columns exactly. It used to be
                    a grid of its own imitating them, which drifted off the
                    columns by the scrollbar's width and its own gaps. Sticky,
                    like the header, so it is reachable on a long diff. */}
                {!!changed.length && (
                  <tfoot>
                    <tr className="cmp-bulk-row">
                      <td />
                      <td className="cmp-a">
                        <button
                          className="btn"
                          onClick={() => setConfirm({ from: right, to: left })}
                          title={t('profile.compare.copyAllTo', { from: rightName, to: leftName })}
                        >
                          <Icon name="arrowLeft" size={12} />
                          {t('profile.compare.copyAllShort', { to: leftName })}
                        </button>
                      </td>
                      {perKeyCopy && <td className="cmp-copy-foot" />}
                      <td className="cmp-b">
                        <button
                          className="btn"
                          onClick={() => setConfirm({ from: left, to: right })}
                          title={t('profile.compare.copyAllTo', { from: leftName, to: rightName })}
                        >
                          {t('profile.compare.copyAllShort', { to: rightName })}
                          <Icon name="arrowRight" size={12} />
                        </button>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>

            {!changed.length && !flat && <p className="cmp-same">{t('profile.compare.allSame')}</p>}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={close}>
            {t('common.done')}
          </button>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={
            confirm.field
              ? t('profile.compare.confirmOne', {
                  field: fieldName(confirm.field),
                  to: slotLabel(device, confirm.to, t),
                  from: slotLabel(device, confirm.from, t),
                })
              : t('profile.compare.confirm', {
                  to: slotLabel(device, confirm.to, t),
                  from: slotLabel(device, confirm.from, t),
                })
          }
          onResolve={(ok) => {
            if (ok) void doCopy(confirm.from, confirm.to, confirm.field);
            else setConfirm(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

/** Every field of two slots, compared. */
function diffPair(
  snap: ProfileSnapshots,
  a: number,
  b: number,
  names: KeyNames,
  t?: TFunc,
): FieldDiff[] {
  const x = snap.slots.find((s) => s.slot === a);
  const y = snap.slots.find((s) => s.slot === b);
  return snap.fields.map((f) => diffField(f, x?.values[f] ?? null, y?.values[f] ?? null, names, t));
}

/**
 * How far apart two slots are, for the pickers' option labels.
 *
 * Keys are counted as a UNION of names across every key-addressed field, not a
 * sum: a key whose actuation and whose colour both changed is one key that
 * differs, and summing would report it twice. `keyTotal` is the largest key
 * count any of those fields saw, i.e. the size of the board.
 */
function distance(snap: ProfileSnapshots, a: number, b: number, names: KeyNames) {
  const keys = new Set<string>();
  let keyTotal = 0;
  let settings = 0;
  for (const d of diffPair(snap, a, b, names)) {
    if (d.same || d.unread) continue;
    settings++;
    if (d.unit === 'key') {
      for (const k of d.changedKeys ?? []) keys.add(k);
      keyTotal = Math.max(keyTotal, d.total);
    }
  }
  return { keys: keys.size, keyTotal: keys.size ? keyTotal : 0, settings };
}

/** A detail value: a swatch when it is a colour, and a note when it is still
 *  the factory setting — which side someone deliberately changed is half of
 *  what a diff is for, and two numbers alone do not say. */
function Val({
  text,
  color,
  isDefault,
  t,
}: {
  text: string;
  color?: string;
  isDefault?: boolean;
  t: ReturnType<typeof useT>;
}) {
  return (
    <span className="cmp-detail-val">
      {color && <span className="cmp-chip" style={{ background: color }} />}
      {/* The value gets its own box so the "(default)" note after it starts at
          the same x on every row — otherwise it tracks the width of whatever
          is to its left ("off" vs "2.50 mm") and the notes zig-zag. */}
      <span className="cmp-num">{text}</span>
      {isDefault && <span className="cmp-default">{t('profile.compare.default')}</span>}
    </span>
  );
}
