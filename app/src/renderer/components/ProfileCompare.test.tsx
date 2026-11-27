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
const isDetail = (r: Element, key: string, setting: string) =>
  r.querySelector('.cmp-key')?.textContent?.trim() === key &&
  r.querySelector('.cmp-sub')?.textContent?.trim() === setting;
const detailRow = (key: string, setting: string) => {
  const hit = [...screen.getByRole('table').querySelectorAll('tr.cmp-detail')].find((r) =>
    isDetail(r, key, setting),
  );
  if (!hit) throw new Error(`no detail row for "${key} ${setting}"`);
  return hit as HTMLTableRowElement;
};
const noDetailRow = (key: string, setting: string) =>
  ![...screen.getByRole('table').querySelectorAll('tr.cmp-detail')].some((r) =>
    isDetail(r, key, setting),
  );
/** A key's own line in a section: its keycap, and the arrows that copy it. */
const keyLine = (key: string, kind: 'cmp-keyhead' | 'cmp-keyline' = 'cmp-keyhead') => {
  const hit = [...screen.getByRole('table').querySelectorAll(`tr.${kind}`)].find(
    (r) => r.querySelector('.cmp-keycap')?.textContent === key,
  );
  if (!hit) throw new Error(`no ${kind} for "${key}"`);
  return hit as HTMLTableRowElement;
};

describe('the profile comparator', () => {
  it('has one row of columns: the setting, the two profiles, and the copy gutter between', async () => {
    open();
    await ready();
    const head = within(screen.getByRole('table')).getAllByRole('columnheader');
    expect(head.map((h) => h.textContent)).toEqual(['Setting', 'Desktop', '', 'Gaming']);
  });

  it('puts every row on the same four columns as the header', async () => {
    open();
    await ready();
    // A nested table computes its own widths and drifts out of alignment, so
    // every row — heading and detail alike — has to be a row of THIS table
    // with the same cell count.
    for (const n of cellCounts()) expect(n).toBe(4);
    expect(detailRow('W', 'Actuation').children).toHaveLength(4);
  });

  it('leads with the number, then the noun', async () => {
    open();
    await ready();
    expect(screen.getByText('1/2 keys differ', { selector: '.cmp-headline' })).toBeTruthy();
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
    expect(head.querySelector('.cmp-key')!.textContent!.trim()).toBe('W');
    expect(head.querySelector('.cmp-sub')!.textContent!.trim()).toBe('Actuation');
  });

  it('marks the side that is still the factory value', async () => {
    open();
    await ready();
    const row = detailRow('W', 'Actuation');
    expect(row.querySelector('td.cmp-a')!.textContent).toContain('(default)');
    expect(row.querySelector('td.cmp-b')!.textContent).not.toContain('(default)');
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

  it('gives each section, and each key in it, its own arrows', async () => {
    open();
    await ready();
    expect(screen.getByTitle('Copy Polling rate from Desktop to Gaming')).toBeTruthy();
    expect(screen.getByTitle('Copy Actuation from Desktop to Gaming')).toBeTruthy();
    expect(screen.getByTitle('Copy W · Actuation from Desktop to Gaming')).toBeTruthy();
  });

  it('copies one section after asking', async () => {
    open();
    await ready();
    await userEvent.click(screen.getByTitle('Copy Polling rate from Gaming to Desktop'));
    expect(
      screen.getByText('Overwrite Polling rate on Desktop with the value from Gaming?'),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() =>
      expect(sdMock.copyProfile).toHaveBeenCalledWith('dev-1', 2, 1, ['pollRate']),
    );
  });

  it('stays open under a confirmation it asked for', async () => {
    // Its OK is portalled, and React bubbles the click through this dialog's
    // backdrop: it used to close the comparison under the copy it confirmed.
    const onClose = vi.fn();
    render(<ProfileCompare device={DEVICE} onClose={onClose} />);
    await ready();
    await userEvent.click(screen.getByTitle('Copy every setting from Desktop to Gaming'));
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sdMock.copyProfile).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
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
 * A keyboard's slot holds its base layer and its actuation. Each is a section
 * of its own — a key that differs in both is listed in each — and inside a
 * section each key can be copied on its own: its binding, or every setting of
 * its actuation, either way.
 */
describe('the profile comparator, on a keyboard', () => {
  const bind = (slot: number, label: string, code: number) => ({
    slot,
    code: code.toString(16),
    kind: 'key',
    label,
    raw: [0, 0, code, 0] as [number, number, number, number],
    provenance: 'device',
  });
  const KB_SNAP: ProfileSnapshots = {
    restoredTo: 1,
    fields: ['keyRemapBase', 'magnetic'],
    slots: [
      {
        slot: 1,
        values: {
          keyRemapBase: { 0: bind(0, 'Esc', 0x29), 5: bind(5, 'W', 0x1a) },
          magnetic: [magW(), magEsc],
        },
      },
      {
        slot: 2,
        values: {
          keyRemapBase: { 0: bind(0, 'Esc', 0x29), 5: bind(5, 'F13', 0x68) },
          magnetic: [magW({ actuationMm: 1.2, rapidTrigger: true }), magEsc],
        },
      },
      {
        slot: 3,
        values: {
          keyRemapBase: { 0: bind(0, 'Esc', 0x29), 5: bind(5, 'W', 0x1a) },
          magnetic: [magW(), magEsc],
        },
      },
    ],
  };

  beforeEach(() => {
    sdMock.snapshotProfiles.mockResolvedValue(KB_SNAP);
    sdMock.copyProfileKeys.mockResolvedValue({ ok: true, verified: 'unverified' });
  });
  const kbReady = () =>
    waitFor(() =>
      expect(screen.getByText('1/2 keys differ', { selector: '.cmp-summary' })).toBeTruthy(),
    );

  it('keeps remap and actuation apart: a key that differs in both is in each', async () => {
    open();
    await kbReady();
    const sections = [...screen.getByRole('table').querySelectorAll('tr.cmp-row')].map(
      (r) => r.querySelector('th')!.textContent,
    );
    expect(sections).toEqual(['Key remap', 'Actuation']);
    // The remap is one line, its two bindings under the two profiles.
    const remap = keyLine('W', 'cmp-keyline');
    expect(remap.querySelector('td.cmp-a')!.textContent).toContain('W');
    expect(remap.querySelector('td.cmp-b')!.textContent).toContain('F13');
    // The actuation is the key's own line, then a row per setting that differs.
    const block = keyLine('W').closest('tbody')!;
    expect(block.querySelectorAll('tr.cmp-detail')).toHaveLength(2);
    expect(detailRow('W', 'Actuation')).toBeTruthy();
    expect(detailRow('W', 'Rapid Trigger')).toBeTruthy();
  });

  it('opens and closes a key from anywhere on its line', async () => {
    open();
    await kbReady();
    await userEvent.click(keyLine('W').querySelector('td.cmp-b')!);
    expect(noDetailRow('W', 'Actuation')).toBe(true);
    await userEvent.click(keyLine('W').querySelector('td.cmp-a')!);
    expect(detailRow('W', 'Actuation')).toBeTruthy();
  });

  it('opens and closes a section from anywhere on its line', async () => {
    open();
    await kbReady();
    const head = [...screen.getByRole('table').querySelectorAll('tr.cmp-row')].find(
      (r) => r.querySelector('th')!.textContent === 'Key remap',
    )!;
    await userEvent.click(head.querySelector('td.cmp-a')!);
    expect(screen.getByRole('table').querySelectorAll('tr.cmp-keyline')).toHaveLength(0);
  });

  it('puts each copy arrow on the side of the profile it copies into', async () => {
    // Reported: the arrow nearest a profile was the one that took FROM it.
    open();
    await kbReady();
    const [left, right] = [...keyLine('W').querySelectorAll('td.cmp-copy button')];
    expect(left!.getAttribute('title')).toBe('Copy W · Actuation from Gaming to Desktop');
    expect(right!.getAttribute('title')).toBe('Copy W · Actuation from Desktop to Gaming');
    const foot = screen.getByRole('table').querySelector('tfoot tr')!;
    expect(foot.querySelector('td.cmp-a button')!.getAttribute('title')).toBe(
      'Copy every setting from Gaming to Desktop',
    );
    expect(foot.querySelector('td.cmp-b button')!.getAttribute('title')).toBe(
      'Copy every setting from Desktop to Gaming',
    );
  });

  it('marks the two profile columns on every row, so they can mirror round the gutter', async () => {
    // The stylesheet centres each profile column either side of the gutter by
    // these classes. (jsdom loads no CSS, so the hooks are what can be pinned.)
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

  it("copies every setting of one key's actuation, and only that, from left to right", async () => {
    open();
    await kbReady();
    await userEvent.click(screen.getByTitle('Copy W · Actuation from Desktop to Gaming'));
    await waitFor(() => expect(sdMock.copyProfileKeys).toHaveBeenCalled());
    // The WHOLE key from slot 1, with slot 2's own W as `previous` — so only
    // the pages that differ go on the wire — and no binding with it.
    expect(sdMock.copyProfileKeys).toHaveBeenCalledWith('dev-1', 1, 2, {
      magnetic: [magW()],
      previous: [magW({ actuationMm: 1.2, rapidTrigger: true })],
      bindings: [],
    });
    // …and the table is read again rather than patched.
    await waitFor(() => expect(sdMock.snapshotProfiles).toHaveBeenCalledTimes(2));
  });

  it("copies one key's remap, and only that, from right to left", async () => {
    open();
    await kbReady();
    await userEvent.click(screen.getByTitle('Copy W · Key remap from Gaming to Desktop'));
    await waitFor(() => expect(sdMock.copyProfileKeys).toHaveBeenCalled());
    expect(sdMock.copyProfileKeys).toHaveBeenCalledWith('dev-1', 2, 1, {
      magnetic: [],
      previous: [],
      bindings: [{ slot: 5, raw: [0, 0, 0x68, 0] }],
    });
  });

  it('takes a Snap-tap partner along, after asking, so the pair is not split', async () => {
    const a = magW({ mode: 'snap', socdPartner: { row: 0, col: 0 } });
    const d = { ...magEsc, mode: 'snap', socdPartner: { row: 1, col: 2 } };
    sdMock.snapshotProfiles.mockResolvedValue({
      ...KB_SNAP,
      slots: [
        { slot: 1, values: { ...KB_SNAP.slots[0]!.values, magnetic: [a, d] } },
        { slot: 2, values: { ...KB_SNAP.slots[0]!.values, magnetic: [magW(), magEsc] } },
        { slot: 3, values: { ...KB_SNAP.slots[0]!.values, magnetic: [magW(), magEsc] } },
      ],
    });
    open();
    await waitFor(() =>
      expect(screen.getByText('2/2 keys differ', { selector: '.cmp-summary' })).toBeTruthy(),
    );
    await userEvent.click(screen.getByTitle('Copy W · Actuation from Desktop to Gaming'));
    expect(screen.getByText('Copy W, Esc to Gaming?')).toBeTruthy();
    expect(sdMock.copyProfileKeys).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sdMock.copyProfileKeys).toHaveBeenCalled());
    expect(sdMock.copyProfileKeys).toHaveBeenCalledWith('dev-1', 1, 2, {
      magnetic: [a, d],
      previous: [magW(), magEsc],
      bindings: [],
    });
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
