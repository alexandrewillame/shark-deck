import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDevice } from '@shared/types/live';
import type { ProfileSnapshots } from '@shared/types/profiles';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import { resetSd, sdMock, sdStub } from '../../../test/lib/sdStub';
import { useStore } from '../state/store';
import { ProfileCompare } from './ProfileCompare';

/**
 * What this dialog has to get right, all of it reported against an earlier
 * version:
 *
 *  - It has to say what actually differs. "79 · 79 · 79 · 79" was a comparison
 *    of collection LENGTHS, equal for two profiles differing on a dozen keys.
 *  - The detail has to line up with the header it sits under, which is why it
 *    is rows of the same table and not a nested one.
 *  - The copy DIRECTION has to be unambiguous, because getting it backwards
 *    destroys the profile the user meant to keep.
 */

vi.stubGlobal('sharkdeck', sdStub);

const DEVICE = {
  id: 'dev-1',
  model: 'attack-shark-r85he',
  capabilities: ['profiles'],
  activeProfile: 1,
  profileNames: { 1: 'Desktop', 2: 'Gaming', 3: 'Office' },
  ui: {
    profileCount: 3,
    keyMatrix: {
      layout: [
        { label: 'Esc', row: 0, col: 0, slot: 0 },
        { label: 'W', row: 1, col: 2, slot: 5 },
      ],
    },
  },
  online: true,
} as unknown as LiveDevice;

const magW = (over: Record<string, unknown> = {}) => ({
  row: 1,
  col: 2,
  actuationMm: KB_TRAVEL_RANGE.travel.default,
  rapidTrigger: false,
  ...over,
});
const magEsc = { row: 0, col: 0, actuationMm: 0.5, rapidTrigger: false };

const SNAP: ProfileSnapshots = {
  restoredTo: 1,
  fields: ['pollRate', 'magnetic', 'debounce'],
  slots: [
    { slot: 1, values: { pollRate: 1000, magnetic: [magW(), magEsc], debounce: 5 } },
    {
      slot: 2,
      // Same key COUNT, different values — the case that used to render as two
      // identical numbers. `debounce` matches, so it is listed as identical
      // rather than shown as a row.
      values: {
        pollRate: 8000,
        magnetic: [magW({ actuationMm: 1.2, rapidTrigger: true }), magEsc],
        debounce: 5,
      },
    },
    // Identical to slot 1, so the pickers can show "identical" for it.
    { slot: 3, values: { pollRate: 1000, magnetic: [magW(), magEsc], debounce: 5 } },
  ],
};

beforeEach(() => {
  resetSd();
  useStore.setState({ toasts: [] });
  sdMock.snapshotProfiles.mockResolvedValue(SNAP);
  sdMock.copyProfile.mockResolvedValue({ ok: true, verified: 'unverified' });
});

const open = () => render(<ProfileCompare device={DEVICE} onClose={() => {}} />);
const ready = () => waitFor(() => expect(screen.getByText('Polling rate')).toBeTruthy());
/** Every row's cell count, header row included. `getAllByRole` takes one role
 *  at a time, and a row mixes `columnheader`/`rowheader` with `cell`, so this
 *  counts the elements rather than the roles. */
const cellCounts = () =>
  [...screen.getByRole('table').querySelectorAll('tr')].map((r) => r.children.length);
/**
 * A per-key detail row, found by its two label parts.
 *
 * Not `getByRole('row', { name })`: the key and the setting are separate
 * elements now, and a row's accessible name is every cell concatenated, so
 * matching on it would couple these tests to the values as well as the label.
 */
const detailRow = (key: string, setting: string) => {
  const hit = [...screen.getByRole('table').querySelectorAll('tr.cmp-detail')].find(
    (r) =>
      r.querySelector('.cmp-key')?.textContent === key &&
      r.querySelector('.cmp-sub')?.textContent?.trim() === setting,
  );
  if (!hit) throw new Error(`no detail row for "${key} ${setting}"`);
  return hit as HTMLTableRowElement;
};
const noDetailRow = (key: string, setting: string) =>
  ![...screen.getByRole('table').querySelectorAll('tr.cmp-detail')].some(
    (r) =>
      r.querySelector('.cmp-key')?.textContent === key &&
      r.querySelector('.cmp-sub')?.textContent?.trim() === setting,
  );

describe('the profile comparator', () => {
  it('has one row of columns: the setting and the two profiles', async () => {
    open();
    await ready();
    // No Copy column. A permanent strip of buttons for an action nobody takes
    // on most rows; whole-profile copy lives under the columns it acts on.
    const head = within(screen.getByRole('table')).getAllByRole('columnheader');
    expect(head.map((h) => h.textContent)).toEqual(['Setting', 'Desktop', 'Gaming']);
  });

  it('puts the detail on the same three columns as the header', async () => {
    open();
    await ready();
    // A nested table computes its own widths and drifts out of alignment, so
    // every row — heading and detail alike — has to be a row of THIS table
    // with the same cell count.
    // Three columns everywhere. A scalar row fills all three; a summary row
    // spans the last two, so it has two cells covering three columns.
    for (const n of cellCounts()) expect(n).toBeLessThanOrEqual(3);
    const detail = detailRow('W', 'Actuation');
    expect(detail.children).toHaveLength(3);
    // …and the header it lines up under has the same three.
    expect(cellCounts()[0]).toBe(3);
  });

  it('leads with the number, then the noun', async () => {
    open();
    await ready();
    expect(screen.getByText('1/2 keys differ')).toBeTruthy();
  });

  it('opens every difference without being asked', async () => {
    open();
    await ready();
    // The detail IS the answer; a dialog of closed rows makes you click to
    // find out whether there was anything worth opening.
    expect(detailRow('W', 'Actuation')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide details' })).toBeTruthy();
  });

  it('collapses and re-opens a row on demand', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole('button', { name: 'Hide details' }));
    expect(noDetailRow('W', 'Actuation')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Show what differs' }));
    expect(detailRow('W', 'Actuation')).toBeTruthy();
  });

  it('tells the key apart from the setting on it', async () => {
    open();
    await ready();
    // Two elements, not one joined string: a key is an object on the board and
    // a setting is a property of it, and the table styles them differently.
    const head = within(detailRow('W', 'Actuation')).getByRole('rowheader');
    expect(head.querySelector('.cmp-key')!.textContent).toBe('W');
    expect(head.querySelector('.cmp-sub')!.textContent!.trim()).toBe('Actuation');
  });

  it('marks the side that is still the factory value', async () => {
    open();
    await ready();
    const cells = within(detailRow('W', 'Actuation')).getAllByRole('cell');
    expect(cells[0]!.textContent).toContain('(default)');
    expect(cells[1]!.textContent).not.toContain('(default)');
  });

  it('shows a scalar as its two actual values', async () => {
    open();
    await ready();
    const row = screen.getByRole('row', { name: /Polling rate/ });
    expect(within(row).getByText('1000')).toBeTruthy();
    expect(within(row).getByText('8000')).toBeTruthy();
  });

  it('leaves settings that match out of the table, with no list of them', async () => {
    open();
    await ready();
    expect(screen.queryByRole('row', { name: /^Debounce/ })).toBeNull();
    // The "Identical on both: …" footnote is gone: what matches is what is
    // not in the table, and spelling it out cost a paragraph under every diff.
    expect(screen.queryByText(/Identical on both/)).toBeNull();
  });

  it('has no per-key copy column when the slot holds more than one field', async () => {
    open();
    await ready();
    expect(screen.queryByTitle(/^Copy W from/)).toBeNull();
  });

  it('tells you how far each profile is before you pick it', async () => {
    open();
    await ready();
    // Left is Desktop, so the right-hand picker scores every candidate against
    // Desktop — answering "which is worth comparing" without committing.
    const picker = screen.getByLabelText('with');
    const opts = within(picker)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Desktop is the opposite selection, so it has no distance from itself.
    // Gaming keeps its note even though it is the current value: that is what
    // makes the collapsed picker say how far apart the pair is.
    expect(opts).toEqual(['Desktop', 'Gaming — 1/2 keys differ', 'Office — identical']);
  });

  it('counts a key once even when several settings on it differ', async () => {
    // W differs in BOTH actuation and rapid trigger. Summing per field would
    // report two keys; the picker unions key names instead.
    open();
    await ready();
    const picker = screen.getByLabelText('with');
    expect(within(picker).getByRole('option', { name: /Gaming/ }).textContent).toBe(
      'Gaming — 1/2 keys differ',
    );
  });

  it('copies left-to-right from the button under the left column', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByTitle('Copy every setting from Desktop to Gaming'));
    expect(screen.getByText('Overwrite Gaming with Desktop?')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sdMock.copyProfile).toHaveBeenCalled());
    expect(sdMock.copyProfile).toHaveBeenCalledWith('dev-1', 1, 2, undefined);
  });

  it('copies right-to-left from the button under the right column', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByTitle('Copy every setting from Gaming to Desktop'));
    expect(screen.getByText('Overwrite Desktop with Gaming?')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sdMock.copyProfile).toHaveBeenCalled());
    expect(sdMock.copyProfile).toHaveBeenCalledWith('dev-1', 2, 1, undefined);
  });

  it('writes nothing when the confirm is dismissed', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByTitle('Copy every setting from Desktop to Gaming'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sdMock.copyProfile).not.toHaveBeenCalled();
  });

  it('re-reads the board after a copy rather than trusting the write', async () => {
    open();
    await waitFor(() => expect(sdMock.snapshotProfiles).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByTitle('Copy every setting from Desktop to Gaming'));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sdMock.snapshotProfiles).toHaveBeenCalledTimes(2));
  });

  it('says which profile it is reading while the sweep runs', async () => {
    // The sweep is one long call on real hardware; a bare spinner reads as a
    // hang, so the slot it is on is the only sign of life.
    let emit: ((p: unknown) => void) | undefined;
    sdMock.on.mockImplementation((ch: string, cb: (p: unknown) => void) => {
      if (ch === 'profiles:progress') emit = cb;
      return () => undefined;
    });
    sdMock.snapshotProfiles.mockReturnValue(new Promise(() => {}));

    open();
    await waitFor(() => expect(emit).toBeDefined());
    emit!({ deviceId: 'dev-1', slot: 2, total: 4 });

    await waitFor(() => expect(screen.getByText('Reading Gaming — profile 2 of 4')).toBeTruthy());
  });

  it('ignores progress from another device', async () => {
    let emit: ((p: unknown) => void) | undefined;
    sdMock.on.mockImplementation((ch: string, cb: (p: unknown) => void) => {
      if (ch === 'profiles:progress') emit = cb;
      return () => undefined;
    });
    sdMock.snapshotProfiles.mockReturnValue(new Promise(() => {}));

    open();
    await waitFor(() => expect(emit).toBeDefined());
    emit!({ deviceId: 'other', slot: 3, total: 4 });

    expect(screen.queryByText(/profile 3 of 4/)).toBeNull();
  });

  it('says so when the sweep fails, instead of showing an empty table', async () => {
    sdMock.snapshotProfiles.mockRejectedValue(new Error('device wedged'));
    open();
    await waitFor(() => expect(screen.getByText(/device wedged/)).toBeTruthy());
  });
});

/**
 * A keyboard's slot holds its actuation settings and nothing else, so there is
 * nothing to group by: keys are listed directly, and each key can be copied on
 * its own — every setting of it, either way.
 */
describe('the profile comparator, on a keyboard', () => {
  const KB_SNAP: ProfileSnapshots = {
    restoredTo: 1,
    fields: ['magnetic'],
    slots: [
      { slot: 1, values: { magnetic: [magW(), magEsc] } },
      { slot: 2, values: { magnetic: [magW({ actuationMm: 1.2, rapidTrigger: true }), magEsc] } },
      { slot: 3, values: { magnetic: [magW(), magEsc] } },
    ],
  };

  beforeEach(() => {
    sdMock.snapshotProfiles.mockResolvedValue(KB_SNAP);
    sdMock.setMagneticKeysOnProfile.mockResolvedValue({ ok: true, verified: 'unverified' });
  });
  const kbReady = () => waitFor(() => expect(screen.getByText('1/2 keys differ')).toBeTruthy());

  it('lists each key and setting directly, with no field to open', async () => {
    open();
    await kbReady();
    expect(screen.queryByRole('button', { name: 'Hide details' })).toBeNull();
    expect(screen.queryByText('Actuation', { selector: '.cmp-disclose' })).toBeNull();
    const head = within(screen.getByRole('table')).getAllByRole('columnheader');
    expect(head.map((h) => h.textContent)).toEqual(['Key', 'Desktop', '', 'Gaming']);
    // W differs in two settings: one block, two rows, named once.
    expect(detailRow('W', 'Actuation')).toBeTruthy();
    expect(detailRow('W', 'Rapid Trigger')).toBeTruthy();
    const block = detailRow('W', 'Actuation').closest('tbody')!;
    expect(block.querySelectorAll('tr')).toHaveLength(2);
    expect(block.querySelectorAll('.cmp-key:not(.cmp-key-repeat)')).toHaveLength(1);
  });

  it('puts each copy arrow on the side of the profile it copies into', async () => {
    // Reported: the arrow nearest a profile was the one that took FROM it.
    open();
    await kbReady();
    const gutter = detailRow('W', 'Actuation').querySelector('td.cmp-copy')!;
    const [left, right] = [...gutter.querySelectorAll('button')];
    expect(left!.title).toBe('Copy W from Gaming to Desktop');
    expect(right!.title).toBe('Copy W from Desktop to Gaming');
    const foot = screen.getByRole('table').querySelector('tfoot tr')!;
    expect(foot.querySelector('td.cmp-a button')!.getAttribute('title')).toBe(
      'Copy every setting from Gaming to Desktop',
    );
    expect(foot.querySelector('td.cmp-b button')!.getAttribute('title')).toBe(
      'Copy every setting from Desktop to Gaming',
    );
  });

  it('marks the two profile columns on every row, so they can mirror round the gutter', async () => {
    // Reported: the copy arrows sat against the right-hand profile rather than
    // between the two. The stylesheet centres each profile column either side
    // of the gutter by these classes — and they have to be on a block's later
    // rows too, which have no copy cell of their own to sit beside. (jsdom
    // loads no CSS, so the hooks are what can be pinned here.)
    open();
    await kbReady();
    expect(screen.getByRole('table').classList.contains('has-copy')).toBe(true);
    for (const row of [detailRow('W', 'Actuation'), detailRow('W', 'Rapid Trigger')]) {
      const values = [...row.querySelectorAll('td')].filter(
        (c) => !c.classList.contains('cmp-copy'),
      );
      expect(values.map((c) => c.className)).toEqual(['cmp-a', 'cmp-b']);
    }
  });

  it('copies every setting of one key from left to right', async () => {
    open();
    await kbReady();
    await userEvent.click(screen.getByTitle('Copy W from Desktop to Gaming'));
    await waitFor(() => expect(sdMock.setMagneticKeysOnProfile).toHaveBeenCalled());
    // The WHOLE key from slot 1, with slot 2's own W as `previous` — so only
    // the pages that differ go on the wire.
    expect(sdMock.setMagneticKeysOnProfile).toHaveBeenCalledWith(
      'dev-1',
      2,
      [magW()],
      [magW({ actuationMm: 1.2, rapidTrigger: true })],
    );
    // …and the table is read again rather than patched.
    await waitFor(() => expect(sdMock.snapshotProfiles).toHaveBeenCalledTimes(2));
  });

  it('copies one key from right to left', async () => {
    open();
    await kbReady();
    await userEvent.click(screen.getByTitle('Copy W from Gaming to Desktop'));
    await waitFor(() => expect(sdMock.setMagneticKeysOnProfile).toHaveBeenCalled());
    expect(sdMock.setMagneticKeysOnProfile).toHaveBeenCalledWith(
      'dev-1',
      1,
      [magW({ actuationMm: 1.2, rapidTrigger: true })],
      [magW()],
    );
  });

  it('takes a Snap-tap partner along, so the pair is not split', async () => {
    const a = magW({ mode: 'snap', socdPartner: { row: 0, col: 0 } });
    const d = { ...magEsc, mode: 'snap', socdPartner: { row: 1, col: 2 } };
    sdMock.snapshotProfiles.mockResolvedValue({
      ...KB_SNAP,
      slots: [
        { slot: 1, values: { magnetic: [a, d] } },
        { slot: 2, values: { magnetic: [magW(), magEsc] } },
        { slot: 3, values: { magnetic: [magW(), magEsc] } },
      ],
    });
    open();
    await waitFor(() => expect(screen.getByText('2/2 keys differ')).toBeTruthy());
    await userEvent.click(screen.getByTitle('Copy W from Desktop to Gaming'));
    await waitFor(() => expect(sdMock.setMagneticKeysOnProfile).toHaveBeenCalled());
    expect(sdMock.setMagneticKeysOnProfile).toHaveBeenCalledWith(
      'dev-1',
      2,
      [a, d],
      [magW(), magEsc],
    );
  });

  it('keeps the bulk copy on the same columns, past the copy column', async () => {
    open();
    await kbReady();
    const foot = screen.getByRole('table').querySelector('tfoot tr')!;
    expect(foot.children).toHaveLength(4);
    expect(
      within(foot as HTMLElement).getByTitle('Copy every setting from Desktop to Gaming'),
    ).toBeTruthy();
  });
});
