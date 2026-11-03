import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type DksZone, EMPTY_DKS_ZONE } from '@shared/dks';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { KeyLayoutEntry } from '@shared/types/keys';
import type { LiveDevice } from '@shared/types/live';
import { resetSd, sdMock } from '../../../../test/lib/sdStub';
import { clearDeviceCache } from '../../state/deviceCache';
import { DksPanel, KeyChooser, ModTapPanel, SnapTapPanel, type ModeContext } from './KeyModePanels';
import { keyIdOf, type Plan } from './magneticModes';

/**
 * The mode panels' wiring: what each control hands to the tab's writer. The
 * rules a plan follows are magneticModes.test.ts's; these check the panels
 * send the right plan, and that mod-tap and DKS write their bindings before
 * their mode.
 */

const key = (row: number, col: number, over: Partial<MagneticKeySettings> = {}) =>
  ({ row, col, actuationMm: 2.5, rapidTrigger: false, mode: 'normal', ...over }) as const;
const A = key(3, 1);
const D = key(3, 3);
const LABEL: Record<string, string> = { [keyIdOf(A)]: 'A', [keyIdOf(D)]: 'D' };
/** A three-key board: A, D, and Fn, which sends no usage. */
const LAYOUT: KeyLayoutEntry[] = [
  { label: 'A', row: 3, col: 1, slot: 9, code: 0x04, x: 1, y: 3 },
  { label: 'D', row: 3, col: 3, slot: 21, code: 0x07, x: 3, y: 3 },
  { label: 'Fn', row: 5, col: 10, slot: 60, code: null, x: 10, y: 5 },
];

function context(map: MagneticKeySettings[], over: Partial<ModeContext> = {}) {
  const applyPlan = vi.fn(async (_label: string, _plan: Plan) => undefined);
  const write = vi.fn(async (_label: string, fn: () => Promise<unknown>) => {
    await fn();
    return { ok: true, verified: 'match' as const };
  });
  const ctx: ModeContext = {
    device: { id: 'kb', capabilities: ['socd', 'modTap', 'dks'] } as unknown as LiveDevice,
    map: Object.fromEntries(map.map((k) => [keyIdOf(k), k])),
    layout: LAYOUT,
    anchor: A,
    selected: [A],
    slot: 9,
    labelOf: (k) => LABEL[keyIdOf(k)] ?? '?',
    colorOf: () => undefined,
    applyPlan,
    write: write as unknown as ModeContext['write'],
    ...over,
  };
  return { ctx, applyPlan, write };
}

beforeEach(() => {
  resetSd();
  clearDeviceCache();
});

describe('SnapTapPanel', () => {
  const paired = [
    key(3, 1, { mode: 'snap', socdPartner: { row: 3, col: 3 } }),
    key(3, 3, { mode: 'snap', socdPartner: { row: 3, col: 1 } }),
  ];

  it('names the partner, and offers no "who wins" list', () => {
    // The firmware's only answer is the key pressed last: the three other
    // values qmk.top names did nothing on an R85HE, so there is no choice to
    // offer.
    const { ctx } = context(paired);
    render(<SnapTapPanel ctx={ctx} draft={false} onDone={vi.fn()} />);
    expect(screen.getByText('Paired with')).toBeTruthy();
    // The partner shows in the chooser, so picking another key changes it.
    expect(screen.getByRole('button', { name: 'Partner key: D' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'While both are held' })).toBeNull();
  });

  it('unpairs both keys', async () => {
    const { ctx, applyPlan } = context(paired);
    render(<SnapTapPanel ctx={ctx} draft={false} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Unpair' }));
    const [, plan] = applyPlan.mock.calls[0]!;
    expect(plan.map((k) => k.mode)).toEqual(['normal', 'normal']);
  });

  it('offers a repair for half a pair', async () => {
    const half = [key(3, 1, { mode: 'snap', socdPartner: { row: 3, col: 3 } }), D];
    const { ctx, applyPlan } = context(half);
    render(<SnapTapPanel ctx={ctx} draft={false} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Repair with D' }));
    const [, plan] = applyPlan.mock.calls[0]!;
    expect(plan.map((k) => [LABEL[keyIdOf(k)], k.mode])).toEqual([
      ['A', 'snap'],
      ['D', 'snap'],
    ]);
  });

  it("offers this board's keys as the partner, and no others", async () => {
    const { ctx } = context([A, D]);
    render(<SnapTapPanel ctx={ctx} draft onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Partner key' }));
    expect(screen.getByRole('button', { name: 'D' })).toBeTruthy();
    // Not the key being paired, not Fn (it sends nothing), not a key the
    // board does not have.
    expect(screen.queryByRole('button', { name: 'A' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Fn' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
  });

  it('writes nothing in draft until a partner is picked; Cancel leaves it', async () => {
    const { ctx, applyPlan } = context([A, D]);
    const onDone = vi.fn();
    render(<SnapTapPanel ctx={ctx} draft onDone={onDone} />);
    expect(screen.getByText(/Nothing is written until you do/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(applyPlan).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('pairs both keys at once when the partner is picked', async () => {
    const { ctx, applyPlan } = context([A, D]);
    const onDone = vi.fn();
    render(<SnapTapPanel ctx={ctx} draft onDone={onDone} />);
    await userEvent.click(screen.getByRole('button', { name: 'Partner key' }));
    await userEvent.click(screen.getByRole('button', { name: 'D' }));
    const [label, plan] = applyPlan.mock.calls[0]!;
    expect(label).toBe('Snap-tap pair');
    expect(plan).toEqual([
      expect.objectContaining({ row: 3, col: 1, mode: 'snap', socdPartner: { row: 3, col: 3 } }),
      expect.objectContaining({ row: 3, col: 3, mode: 'snap', socdPartner: { row: 3, col: 1 } }),
    ]);
    expect(onDone).toHaveBeenCalled();
  });

  it('takes the partner from the keyboard: press it while the chooser is open', async () => {
    const { ctx, applyPlan } = context([A, D]);
    render(<SnapTapPanel ctx={ctx} draft onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Partner key' }));
    fireEvent.keyDown(window, { code: 'KeyD', key: 'd' });
    const [, plan] = applyPlan.mock.calls[0]!;
    expect(plan.map((k) => [LABEL[keyIdOf(k)], k.mode])).toEqual([
      ['A', 'snap'],
      ['D', 'snap'],
    ]);
    // A key the board lacks is not a partner, however it is typed.
    fireEvent.keyDown(window, { code: 'KeyB', key: 'b' });
    expect(applyPlan).toHaveBeenCalledTimes(1);
  });
});

describe('KeyChooser', () => {
  it('opens a centred modal dialog, focused, and hands focus back when it closes', async () => {
    render(<KeyChooser value={null} onChange={vi.fn()} label="Key to hold" />);
    const trigger = screen.getByRole('button', { name: 'Key to hold' });
    await userEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Key to hold' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.closest('.modal-scrim')).not.toBeNull();
    // Focused on open: the Actuation tab's test mode lets keys through to a
    // dialog, and its Escape leaves one alone.
    expect(document.activeElement).toBe(dialog);

    // A press on the scrim closes it…
    fireEvent.mouseDown(dialog.closest('.modal-scrim')!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // …and so does Escape.
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Key to hold' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('stays open for a press inside it, and closes once a key is picked', async () => {
    const onChange = vi.fn();
    render(<KeyChooser value={null} onChange={onChange} label="Key to hold" />);
    await userEvent.click(screen.getByRole('button', { name: 'Key to hold' }));
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Left Ctrl' }));
    expect(onChange).toHaveBeenCalledWith('e0');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers only the groups it is given', async () => {
    const groups = [{ label: 'Two keys', keys: [{ label: 'A', code: '4' }] }];
    render(<KeyChooser value={null} onChange={vi.fn()} label="Partner key" groups={groups} />);
    await userEvent.click(screen.getByRole('button', { name: 'Partner key' }));
    expect(screen.getByRole('button', { name: 'A' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'B' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Left Ctrl' })).toBeNull();
  });
});

describe('ModTapPanel', () => {
  /** A's own binding on the base layer: usage 0x04. */
  const BASE = { 9: { slot: 9, code: '04', kind: 'key', raw: [0, 0, 4, 0], provenance: 'device' } };

  it('cannot apply until a hold key is chosen', () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    sdMock.readKeyBindings.mockResolvedValue(BASE);
    const { ctx } = context([A]);
    render(<ModTapPanel ctx={ctx} draft onDone={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Apply/ }).hasAttribute('disabled')).toBe(true);
  });

  it('cannot apply until it knows what the key types, which becomes the tap', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    sdMock.readKeyBindings.mockResolvedValue(null);
    const { ctx } = context([A]);
    render(<ModTapPanel ctx={ctx} draft onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Key to hold' }));
    await userEvent.click(screen.getByRole('button', { name: 'Left Ctrl' }));
    expect(screen.getByRole('button', { name: /Apply/ }).hasAttribute('disabled')).toBe(true);
    expect(sdMock.setKeyZoneBindings).not.toHaveBeenCalled();
  });

  it('writes the hold to zone 0 and the key itself to zone 1, then the mode', async () => {
    // The board fires zone 0 on a HOLD and zone 1 on a TAP — the other way
    // round from the first version, which made A tap Ctrl and hold `a`.
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    sdMock.readKeyBindings.mockResolvedValue(BASE);
    const { ctx, applyPlan } = context([A]);
    const onDone = vi.fn();
    render(<ModTapPanel ctx={ctx} draft onDone={onDone} />);
    await screen.findByRole('generic', { name: 'A' });
    await userEvent.click(screen.getByRole('button', { name: 'Key to hold' }));
    await userEvent.click(screen.getByRole('button', { name: 'Left Ctrl' }));
    await userEvent.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sdMock.setKeyZoneBindings).toHaveBeenCalledWith('kb', 9, ['e0', '04']);
    const [, plan] = applyPlan.mock.calls[0]!;
    expect(plan[0]).toMatchObject({ mode: 'mt', mtHoldMs: 200 });
    expect(sdMock.setKeyZoneBindings.mock.invocationCallOrder[0]!).toBeLessThan(
      applyPlan.mock.invocationCallOrder[0]!,
    );
  });

  it('starts from the hold and tap this computer last wrote', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({ 9: ['e1', '05'] });
    sdMock.readKeyBindings.mockResolvedValue(BASE);
    const { ctx } = context([key(3, 1, { mode: 'mt', mtHoldMs: 300 })]);
    render(<ModTapPanel ctx={ctx} draft={false} onDone={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Key to hold: Left Shift' })).toBeTruthy();
    // The tap is the recorded one (B), not whatever the base layer says.
    expect(await screen.findByRole('generic', { name: 'B' })).toBeTruthy();
  });

  it('takes the hold key from the keyboard: press it while the chooser is open', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    sdMock.readKeyBindings.mockResolvedValue(BASE);
    const { ctx } = context([A]);
    render(<ModTapPanel ctx={ctx} draft onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Key to hold' }));
    fireEvent.keyDown(window, { code: 'ControlLeft', key: 'Control' });
    expect(await screen.findByRole('button', { name: 'Key to hold: Left Ctrl' })).toBeTruthy();
    // ...and the chooser closed behind it.
    expect(screen.queryByRole('dialog', { name: 'Key to hold' })).toBeNull();
  });

  it('opens a key set up the old way round with its hold chosen', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({ 9: [null, 'e1'] });
    sdMock.readKeyBindings.mockResolvedValue(BASE);
    const { ctx } = context([key(3, 1, { mode: 'mt', mtHoldMs: 300 })]);
    render(<ModTapPanel ctx={ctx} draft={false} onDone={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Key to hold: Left Shift' })).toBeTruthy();
  });
});

describe('DksPanel', () => {
  const zone = (over: Partial<DksZone>): DksZone => ({ ...EMPTY_DKS_ZONE, ...over });
  /** Render, Apply, and hand back what reached the board. */
  const applied = async (
    applyPlan: ReturnType<typeof context>['applyPlan'],
    onDone: () => void,
  ) => {
    await userEvent.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [, plan] = applyPlan.mock.calls[0]!;
    return plan[0]!;
  };

  it('starts a new key with the key itself tapping at Press, nothing else bound', async () => {
    // The vendor app's own start; an empty grid applied as a key that did
    // nothing. Bindings go before the mode plan, as with mod-tap.
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    const { ctx, applyPlan } = context([A]);
    const onDone = vi.fn();
    render(<DksPanel ctx={ctx} draft onDone={onDone} />);
    const k = await applied(applyPlan, onDone);
    expect(k).toMatchObject({ mode: 'dks', dksPointMm: 0.7 });
    expect(k.dksZones).toEqual([zone({ a: 'A' }), EMPTY_DKS_ZONE, EMPTY_DKS_ZONE, EMPTY_DKS_ZONE]);
    expect(sdMock.setKeyZoneBindings).toHaveBeenCalledWith('kb', 9, [null, '', '', '']);
    expect(sdMock.setKeyZoneBindings.mock.invocationCallOrder[0]!).toBeLessThan(
      applyPlan.mock.invocationCallOrder[0]!,
    );
  });

  it('seeds a newly bound action with a tap at its own point', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    const { ctx, applyPlan } = context([A]);
    const onDone = vi.fn();
    render(<DksPanel ctx={ctx} draft onDone={onDone} />);
    // Unbound, its cells cannot be set.
    expect(
      screen.getByRole('combobox', { name: 'Action 2 at Bottom' }).hasAttribute('disabled'),
    ).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Action 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Left Ctrl' }));
    expect(
      screen.getByRole('combobox', { name: 'Action 2 at Bottom' }).hasAttribute('disabled'),
    ).toBe(false);
    const k = await applied(applyPlan, onDone);
    expect(sdMock.setKeyZoneBindings).toHaveBeenCalledWith('kb', 9, [null, 'e0', '', '']);
    expect(k.dksZones![1]).toEqual(zone({ b: 'B' }));
  });

  it('names each cell by action and point, and a hold takes the points it covers', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({});
    const { ctx, applyPlan } = context([A]);
    const onDone = vi.fn();
    render(<DksPanel ctx={ctx} draft onDone={onDone} />);
    await userEvent.click(screen.getByRole('combobox', { name: 'Action 1 at Press' }));
    for (const name of [
      'Nothing',
      'Tap here',
      'Hold until Bottom',
      'Hold until Lift',
      'Hold until Release',
    ])
      expect(screen.getByRole('option', { name })).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(5);
    await userEvent.click(screen.getByRole('option', { name: 'Hold until Lift' }));
    // One element from Press to Lift: Bottom and Lift have no cell of their own now.
    expect(screen.getByRole('combobox', { name: 'Action 1 at Press' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Action 1 at Bottom' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Action 1 at Lift' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Action 1 at Release' })).toBeTruthy();
    const k = await applied(applyPlan, onDone);
    expect(k.dksZones![0]).toEqual(zone({ a: 'A-CS' }));
  });

  it('unbinding an action clears its row', async () => {
    sdMock.readKeyZoneBindings.mockResolvedValue({ 9: [null, 'e0', '', ''] });
    const zones = [zone({ a: 'A' }), zone({ b: 'B' }), zone({}), zone({})];
    const { ctx, applyPlan } = context([
      key(3, 1, { mode: 'dks', dksPointMm: 0.7, dksZones: zones }),
    ]);
    const onDone = vi.fn();
    render(<DksPanel ctx={ctx} draft={false} onDone={onDone} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Action 2: Left Ctrl' }));
    await userEvent.click(screen.getByRole('button', { name: 'Nothing' }));
    const k = await applied(applyPlan, onDone);
    expect(sdMock.setKeyZoneBindings).toHaveBeenCalledWith('kb', 9, [null, '', '', '']);
    expect(k.dksZones![1]).toEqual(EMPTY_DKS_ZONE);
    expect(k.dksZones![0]).toEqual(zone({ a: 'A' }));
  });
});
