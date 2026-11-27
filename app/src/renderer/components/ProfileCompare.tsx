import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { LiveDevice } from '@shared/types/live';
import type { ProfileField, ProfileSnapshots } from '@shared/types/profiles';
import type { MessageKey, TFunc } from '@shared/i18n';
import { ConfirmDialog } from './common';
import { Icon } from './icons';
import {
  diffField,
  keyBlocks,
  keyNames,
  planKeyCopy,
  type DiffRow,
  type FieldDiff,
  type KeyCopyField,
  type KeyDiffBlock,
  type KeyNames,
} from './profileDiff';
import { dropDeviceCache, sd, useDeviceBusy, useWrite } from '../tabs/common';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { slotLabel } from '../state/ui';

/** Up to this many keys differ in their actuation, each opens on its
 *  settings; past it, the section opens as the list of keys, each a click
 *  away from its settings. */
const KEYS_OPEN_UP_TO = 8;

/** The key fields whose keys are each copied on their own (`planKeyCopy`). */
const isKeyCopy = (f: ProfileField): f is KeyCopyField => f === 'keyRemapBase' || f === 'magnetic';

/** A key's one copy: which key, by layout index and name, and of which field. */
interface KeyRef {
  index: number;
  name: string;
  field: KeyCopyField;
}

type Confirm =
  | { kind: 'all'; from: number; to: number }
  | { kind: 'field'; from: number; to: number; field: ProfileField }
  | { kind: 'pair'; from: number; to: number; key: KeyRef; partners: string[] };

/**
 * A row that opens and closes what is under it, by a click anywhere on it —
 * its disclosure button is for the keyboard. A click on any other button in
 * the row (the copy arrows) is that button's.
 */
const toggleRow = (toggle: () => void) => (e: ReactMouseEvent<HTMLTableRowElement>) => {
  if ((e.target as Element).closest('button, select, a, input')) return;
  toggle();
};

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
 * One section per setting — a keyboard's Key remap and Actuation are two, and
 * stay two: a key that differs in both is listed in each. Inside a section,
 * what is addressed by key is drawn per KEY: a key whose remap differs is one
 * line; a key whose actuation differs is its name on a line, then each of its
 * settings that differ. Between the two profiles, arrows copy what the line
 * holds either way — a section's arrows the whole setting, a key's that key's
 * share of it.
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
  /** Collapsed sections. Empty = everything open, which is the default: the
   *  detail IS the answer, and a dialog of closed rows makes you click to find
   *  out whether there was anything worth opening. */
  const [collapsed, setCollapsed] = useState<Set<ProfileField>>(new Set());
  /** Keys' actuation, the same way round: open or closed by default
   *  (`KEYS_OPEN_UP_TO`, or the last Expand / Collapse all), and the keys
   *  toggled from that. */
  const [keysOpen, setKeysOpen] = useState<boolean | null>(null);
  const [keysToggled, setKeysToggled] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);

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

  const layout = device.ui.keyMatrix?.layout;

  /**
   * One key's share of one setting, from one profile onto the other
   * (`planKeyCopy`): its remap, or all of its actuation. A key of a Snap Tap
   * pair takes its partner's actuation with it, which is asked first — that
   * partner changes too. The values come from the sweep this table was drawn
   * from (the dialog is modal and busy-locked, so they cannot have moved).
   */
  const copyKey = async (key: KeyRef, from: number, to: number, asked = false) => {
    if (!snap) return;
    const plan = planKeyCopy(snap, layout, key.index, from, to, key.field);
    if (!plan) return;
    if (plan.partners.length && !asked) {
      setConfirm({
        kind: 'pair',
        from,
        to,
        key,
        partners: plan.partners.map((i) => layout?.[i]?.label ?? `#${i}`),
      });
      return;
    }
    setConfirm(null);
    await whileBusy(t('profile.compare.writing'), () =>
      run(`${key.name} → ${slotLabel(device, to, t)}`, () =>
        sd.copyProfileKeys(device.id, from, to, plan.copy),
      ),
    );
    if (to === device.activeProfile) touchedActive.current = true;
    await load();
  };

  const names = useMemo(() => keyNames(layout), [layout]);
  const diffs = useMemo(
    () => (snap ? diffPair(snap, left, right, names, t) : []),
    [snap, left, right, names, t],
  );
  const fieldName = (f: ProfileField) => t(`pf.${f}` as MessageKey);

  const changed = diffs.filter((d) => !d.same && !d.unread);
  /** Each key section's keys, in board order, top row first. */
  const blocksOf = useMemo(() => {
    const m = new Map<ProfileField, KeyDiffBlock[]>();
    for (const d of changed)
      if (d.unit === 'key') m.set(d.field, keyBlocks([d], layout, fieldName));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diffs, layout]);
  const actuationKeys = blocksOf.get('magnetic')?.length ?? 0;

  // Whether keys open on their settings is settled by the first comparison
  // drawn, and then kept: a copy that brings the count under the line must not
  // spring every block open under the pointer.
  useEffect(() => {
    if (keysOpen === null && snap) setKeysOpen(actuationKeys <= KEYS_OPEN_UP_TO);
  }, [snap, actuationKeys, keysOpen]);
  const keyIsOpen = (i: number) => (keysOpen ?? true) !== keysToggled.has(i);
  const toggleKey = (i: number) =>
    setKeysToggled((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const toggleField = (f: ProfileField) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

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

  /**
   * The gutter between the two profiles: the arrow on each side copies INTO
   * that side's profile — left into the left one, right into the right.
   */
  const arrows = (what: string, toLeft: () => void, toRight: () => void) => {
    const intoLeft = t('profile.compare.copyFieldTo', {
      field: what,
      from: rightName,
      to: leftName,
    });
    const intoRight = t('profile.compare.copyFieldTo', {
      field: what,
      from: leftName,
      to: rightName,
    });
    return (
      <>
        <button
          type="button"
          className="btn-icon"
          title={intoLeft}
          aria-label={intoLeft}
          onClick={toLeft}
        >
          <Icon name="copyLeft" size={14} />
        </button>
        <button
          type="button"
          className="btn-icon"
          title={intoRight}
          aria-label={intoRight}
          onClick={toRight}
        >
          <Icon name="copyRight" size={14} />
        </button>
      </>
    );
  };
  /** A key's arrows, for one setting: "Esc · Actuation". */
  const keyArrows = (key: KeyRef) =>
    arrows(
      `${key.name} · ${fieldName(key.field)}`,
      () => void copyKey(key, right, left),
      () => void copyKey(key, left, right),
    );

  const confirmTitle = (c: Confirm): string => {
    const to = slotLabel(device, c.to, t);
    const from = slotLabel(device, c.from, t);
    switch (c.kind) {
      case 'all':
        return t('profile.compare.confirm', { to, from });
      case 'field':
        return t('profile.compare.confirmOne', { field: fieldName(c.field), to, from });
      case 'pair':
        return t('profile.compare.pairTitle', { keys: [c.key.name, ...c.partners].join(', '), to });
    }
  };

  /** One detail line: a setting and its two values. */
  const detail = (r: DiffRow, key: string, indent: string, keyName?: string) => (
    <tr key={key} className={`cmp-detail ${indent}`}>
      {/* The key and the setting on it are different kinds of thing, so they
          are told apart by weight and colour rather than by a separator the
          eye has to parse. Under a key's own line the key's name is kept for
          a screen reader only, so the row still reads "W Release". */}
      <th scope="row">
        {keyName ? (
          <span className="cmp-key cmp-key-repeat">{keyName} </span>
        ) : (
          <span className="cmp-key">{r.label}</span>
        )}
        {r.setting && <span className="cmp-sub">{keyName ? r.setting : ` ${r.setting}`}</span>}
      </th>
      <td className="cmp-a">
        <Val text={r.a} color={r.aColor} isDefault={r.aDefault} t={t} />
      </td>
      <td className="cmp-copy" />
      <td className="cmp-b">
        <Val text={r.b} color={r.bColor} isDefault={r.bDefault} t={t} />
      </td>
    </tr>
  );

  /** A section's own line: its name, how much differs, its arrows. */
  const sectionHead = (d: FieldDiff, canOpen: boolean, open: boolean) => (
    <tr
      className={canOpen ? 'cmp-row cmp-toggle' : 'cmp-row'}
      onClick={canOpen ? toggleRow(() => toggleField(d.field)) : undefined}
    >
      <th scope="row">
        {canOpen ? (
          <button
            type="button"
            className="cmp-disclose"
            aria-expanded={open}
            aria-label={open ? t('profile.compare.collapse') : t('profile.compare.expand')}
            onClick={() => toggleField(d.field)}
          >
            {/* One glyph, rotated — a disclosure triangle that turns is the
                convention, and it keeps the two states from drifting into two
                drawings. */}
            <span className={`cmp-caret ${open ? 'is-open' : ''}`}>
              <Icon name="chevronRight" size={11} />
            </span>
            {fieldName(d.field)}
          </button>
        ) : (
          <span className="cmp-nodisclose">{fieldName(d.field)}</span>
        )}
      </th>
      {/* A scalar puts its two values under the two profile columns, where
          they line up with the headers. Anything with lines under it has no
          single value, so its summary sits in the first. */}
      <td className="cmp-v cmp-a">
        {d.unit === 'value' ? d.a : <span className="cmp-headline">{headline(d)}</span>}
      </td>
      <td className="cmp-copy">
        {arrows(
          fieldName(d.field),
          () => setConfirm({ kind: 'field', from: right, to: left, field: d.field }),
          () => setConfirm({ kind: 'field', from: left, to: right, field: d.field }),
        )}
      </td>
      <td className="cmp-v cmp-b">{d.unit === 'value' ? d.b : null}</td>
    </tr>
  );

  /** One section, as the run of `<tbody>`s it draws. */
  const section = (d: FieldDiff) => {
    const open = !collapsed.has(d.field);
    const blocks = blocksOf.get(d.field);
    if (!blocks) {
      // Per setting: a line per difference under the section's own.
      return (
        <tbody key={d.field} className="cmp-section">
          {sectionHead(d, d.rows.length > 0, open)}
          {open &&
            d.rows.map((r, i) => detail(r, `${d.field}-${r.label}-${r.setting ?? ''}-${i}`, ''))}
        </tbody>
      );
    }
    const field = isKeyCopy(d.field) ? d.field : null;
    if (d.field !== 'magnetic') {
      // One line per key: a key holds one binding (or one colour, one switch).
      return (
        <tbody key={d.field} className="cmp-section">
          {sectionHead(d, true, open)}
          {open &&
            blocks.map((b) => {
              const r = b.rows[0]!;
              return (
                <tr key={b.index} className="cmp-keyline">
                  <th scope="row">
                    <span className="cmp-keycap">{b.name}</span>
                  </th>
                  <td className="cmp-a">
                    <Val text={r.a} color={r.aColor} isDefault={r.aDefault} t={t} />
                  </td>
                  <td className="cmp-copy">
                    {field && keyArrows({ index: b.index, name: b.name, field })}
                  </td>
                  <td className="cmp-b">
                    <Val text={r.b} color={r.bColor} isDefault={r.bDefault} t={t} />
                  </td>
                </tr>
              );
            })}
        </tbody>
      );
    }
    // Actuation: a key's name on a line of its own — its arrows copy all of
    // its actuation — and each setting that differs under it.
    return (
      <Fragment key={d.field}>
        <tbody className="cmp-section">{sectionHead(d, true, open)}</tbody>
        {open &&
          blocks.map((b, n) => {
            const kOpen = keyIsOpen(b.index);
            return (
              <tbody
                key={`${d.field}-${b.index}`}
                className={n % 2 ? 'cmp-keyblock is-banded' : 'cmp-keyblock'}
              >
                <tr
                  className="cmp-keyhead cmp-toggle"
                  onClick={toggleRow(() => toggleKey(b.index))}
                >
                  <th scope="rowgroup">
                    <button
                      type="button"
                      className="cmp-disclose"
                      aria-expanded={kOpen}
                      onClick={() => toggleKey(b.index)}
                    >
                      <span className={`cmp-caret ${kOpen ? 'is-open' : ''}`}>
                        <Icon name="chevronRight" size={11} />
                      </span>
                      <span className="cmp-keycap">{b.name}</span>
                      <span className="cmp-count">
                        {b.rows.length === 1
                          ? t('profile.compare.diffOne')
                          : t('profile.compare.diffSettings', { n: b.rows.length })}
                      </span>
                    </button>
                  </th>
                  <td className="cmp-a" />
                  <td className="cmp-copy">
                    {keyArrows({ index: b.index, name: b.name, field: 'magnetic' })}
                  </td>
                  <td className="cmp-b" />
                </tr>
                {kOpen &&
                  b.rows.map((r, i) =>
                    detail(r, `${r.setting ?? ''}-${i}`, 'cmp-under-key', b.name),
                  )}
              </tbody>
            );
          })}
      </Fragment>
    );
  };

  /** "5/79 keys differ", whichever keys and settings there are. */
  const keysDiffering = new Set<number>();
  for (const blocks of blocksOf.values()) for (const b of blocks) keysDiffering.add(b.index);
  const keyTotal = Math.max(0, ...changed.filter((d) => d.unit === 'key').map((d) => d.total));
  const others = changed.filter((d) => d.unit !== 'key');
  const summary = [
    keysDiffering.size
      ? t('profile.compare.diffKeys', { n: keysDiffering.size, total: keyTotal })
      : '',
    others.length
      ? t('profile.compare.summary', {
          n: others.length,
          total: diffs.filter((d) => d.unit !== 'key').length,
        })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return createPortal(
    // Only a click on the backdrop ITSELF closes: a confirmation's buttons are
    // portalled, and React bubbles their clicks through here — its OK used to
    // close this dialog under the copy it had just confirmed.
    <div
      className="modal-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h4>{t('profile.compare')}</h4>

        {/* Which two, always visible — it is the thing every row below is
            relative to, and what makes a copy direction unambiguous. */}
        <div className="cmp-pair">
          <span className="hint">{t('profile.compare.between')}</span>
          <select
            className="cmp-pick"
            value={left}
            disabled={!snap}
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
            disabled={!snap}
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
        {/* The sweep takes seconds on a keyboard (every slot, page by page),
            and an empty dialog read as one that had failed to open: a
            spinner, which slot, and how far along. */}
        {!snap && !error && (
          <div className="cmp-loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <div className="cmp-loading-body">
              <div>
                {progress
                  ? t('profile.compare.readingSlot', {
                      name: slotLabel(device, progress.slot, t),
                      n: progress.slot,
                      total: progress.total,
                    })
                  : `${t('profile.compare.reading')}…`}
              </div>
              <div className="cmp-progress" aria-hidden="true">
                <span
                  style={{
                    width: `${progress ? (100 * (progress.slot - 0.5)) / progress.total : 4}%`,
                  }}
                />
              </div>
            </div>
          </div>
        )}
        {snap && !snap.fields.length && <p>{t('profile.compare.empty')}</p>}

        {snap && !!snap.fields.length && left === right && (
          <p className="cmp-same">{t('profile.compare.allSame')}</p>
        )}

        {snap && !!snap.fields.length && left !== right && (
          <>
            <div className="cmp-summary-line">
              <p className="cmp-summary">
                {changed.length ? summary : t('profile.compare.allSame')}
              </p>
              {actuationKeys > 1 && !collapsed.has('magnetic') && (
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setKeysOpen(!(keysOpen ?? true));
                    setKeysToggled(new Set());
                  }}
                >
                  {(keysOpen ?? true)
                    ? t('profile.compare.collapseAll')
                    : t('profile.compare.expandAll')}
                </button>
              )}
            </div>
            {/* The SCROLLPORT is this wrapper, not the table. Putting
                `overflow` on the table itself needs `display: block` on it and
                `display: table` back on thead/tbody, which stops it being a
                table for sizing and lets the notes below overlap it.
                Not drawn at all when nothing differs: a header with no rows
                under it read as a table that failed to load. */}
            <div className="cmp-scroll" hidden={!changed.length}>
              <table className="cmp-table has-copy">
                <colgroup>
                  <col className="cmp-c-setting" />
                  <col />
                  <col className="cmp-c-copy" />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th>{t('profile.compare.colSetting')}</th>
                    <th className="cmp-a">{leftName}</th>
                    <th className="cmp-copy-head" aria-label={t('profile.compare.colCopy')} />
                    <th className="cmp-b">{rightName}</th>
                  </tr>
                </thead>
                {changed.map(section)}
                {/* "Copy all", under the column it copies TO — like the
                    per-key arrows, each points outward at its own side. In
                    the table's own footer, so it shares the columns exactly.
                    It used to be a grid of its own imitating them, which
                    drifted off the columns by the scrollbar's width and its
                    own gaps. Sticky, like the header, so it is reachable on a
                    long diff. */}
                {!!changed.length && (
                  <tfoot>
                    <tr className="cmp-bulk-row">
                      <td />
                      <td className="cmp-a">
                        <button
                          className="btn"
                          onClick={() => setConfirm({ kind: 'all', from: right, to: left })}
                          title={t('profile.compare.copyAllTo', { from: rightName, to: leftName })}
                        >
                          <Icon name="arrowLeft" size={12} />
                          {t('profile.compare.copyAllShort', { to: leftName })}
                        </button>
                      </td>
                      <td className="cmp-copy-foot" />
                      <td className="cmp-b">
                        <button
                          className="btn"
                          onClick={() => setConfirm({ kind: 'all', from: left, to: right })}
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
          title={confirmTitle(confirm)}
          body={
            confirm.kind === 'pair'
              ? t('profile.compare.pairBody', {
                  key: confirm.key.name,
                  partners: confirm.partners.join(', '),
                  from: slotLabel(device, confirm.from, t),
                })
              : undefined
          }
          onResolve={(ok) => {
            if (!ok) setConfirm(null);
            else if (confirm.kind === 'pair')
              void copyKey(confirm.key, confirm.from, confirm.to, true);
            else
              void doCopy(
                confirm.from,
                confirm.to,
                confirm.kind === 'field' ? confirm.field : undefined,
              );
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
