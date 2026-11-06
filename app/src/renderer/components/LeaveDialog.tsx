import type { MessageKey } from '@shared/i18n';
import type { LiveDevice } from '@shared/types/live';
import { ModalFrame } from './common';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { deviceName } from '../state/ui';
import {
  resolveLeave,
  useLeaveRequest,
  type LeaveExit,
  type PendingItem,
  type PendingKind,
} from '../state/leaveGuard';

/**
 * The one prompt for leaving with changes nobody applied (state/leaveGuard.ts),
 * rendered once by App.
 *
 * Keep editing comes first, so it has the focus: Enter, Escape and a click on
 * the backdrop all stay. Discard is the red one. A single change also offers
 * to apply it (or save it, for a macro) and then go; several cannot be applied
 * as one — the board shows either a Global effect or its per-key picture, not
 * both — so they are listed and only discarded together.
 */

const TITLE: Record<PendingKind | 'many', Record<LeaveExit, MessageKey>> = {
  apply: {
    leave: 'leave.title.apply',
    switch: 'leave.title.applySwitch',
    quit: 'leave.title.applyQuit',
  },
  save: {
    leave: 'macro.leave.title',
    switch: 'leave.title.saveSwitch',
    quit: 'leave.title.saveQuit',
  },
  many: {
    leave: 'leave.title.many',
    switch: 'leave.title.manySwitch',
    quit: 'leave.title.manyQuit',
  },
};

const LOST: Record<LeaveExit, MessageKey> = {
  leave: 'leave.body.lost',
  switch: 'leave.body.lostSwitch',
  quit: 'leave.body.lostQuit',
};

/** For a change whose label is plural ("Per-key colours"). */
const LOST_THEM: Record<LeaveExit, MessageKey> = {
  leave: 'leave.body.lostThem',
  switch: 'leave.body.lostThemSwitch',
  quit: 'leave.body.lostThemQuit',
};

const LOST_MANY: Record<LeaveExit, MessageKey> = {
  leave: 'leave.body.lostMany',
  switch: 'leave.body.lostManySwitch',
  quit: 'leave.body.lostManyQuit',
};

const MACRO_BODY: Record<LeaveExit, MessageKey> = {
  leave: 'macro.leave.body',
  switch: 'leave.body.macroSwitch',
  quit: 'leave.body.macroQuit',
};

const DISCARD: Record<LeaveExit, MessageKey> = {
  leave: 'leave.discard',
  switch: 'leave.discardSwitch',
  quit: 'leave.discardQuit',
};

const COMMIT: Record<PendingKind, Record<LeaveExit, MessageKey>> = {
  apply: { leave: 'leave.apply', switch: 'leave.applySwitch', quit: 'leave.applyQuit' },
  save: { leave: 'leave.save', switch: 'leave.saveSwitch', quit: 'leave.saveQuit' },
};

function notAppliedBody(kind: LiveDevice['kind'] | undefined, plural: boolean): MessageKey {
  if (kind === 'keyboard') return plural ? 'leave.body.keyboardThem' : 'leave.body.keyboard';
  if (kind === 'mouse') return plural ? 'leave.body.mouseThem' : 'leave.body.mouse';
  return plural ? 'leave.body.deviceThem' : 'leave.body.device';
}

function notAppliedManyBody(kind: LiveDevice['kind'] | undefined): MessageKey {
  if (kind === 'keyboard') return 'leave.body.manyKeyboard';
  if (kind === 'mouse') return 'leave.body.manyMouse';
  return 'leave.body.many';
}

export function LeaveDialog() {
  const t = useT();
  const req = useLeaveRequest();
  const devices = useStore((s) => s.devices);
  if (!req) return null;
  const { exit, items } = req;
  const deviceOf = (id: string) => devices.find((d) => d.id === id);
  const keep = () => void resolveLeave('keep');
  const keepButton = (
    <button className="btn" onClick={keep}>
      {t('leave.keep')}
    </button>
  );
  const discardButton = (
    <button className="btn danger" onClick={() => void resolveLeave('discard')}>
      {t(DISCARD[exit])}
    </button>
  );

  if (items.length === 1) {
    const { deviceId, change } = items[0]!;
    const device = deviceOf(deviceId);
    const name = change.label();
    const plural = !!change.plural;
    const body =
      change.kind === 'save'
        ? t(MACRO_BODY[exit], { name })
        : `${t(notAppliedBody(device?.kind, plural), { name })} ${t((plural ? LOST_THEM : LOST)[exit])}`;
    // Applying needs the device to answer; saving a macro does not.
    const canCommit = !!change.commit && (change.kind === 'save' || !!device?.online);
    return (
      <ModalFrame
        className="modal-leave"
        title={t(TITLE[change.kind][exit])}
        body={body}
        onCancel={keep}
      >
        {keepButton}
        {discardButton}
        {canCommit && (
          <button className="btn primary" onClick={() => void resolveLeave('commit')}>
            {t(COMMIT[change.kind][exit])}
          </button>
        )}
      </ModalFrame>
    );
  }

  // Several at once: on one device (the two lighting editors), or, quitting,
  // spread over several — then each line says which device it is on.
  const ids = new Set(items.map((i) => i.deviceId));
  const only = ids.size === 1 ? deviceOf([...ids][0]!) : undefined;
  const what = (i: PendingItem) => {
    const label =
      i.change.kind === 'save'
        ? t('leave.what.macro', { name: i.change.label() })
        : i.change.label();
    if (ids.size === 1) return label;
    const d = deviceOf(i.deviceId);
    return t('leave.what.onDevice', { device: d ? deviceName(d, t) : i.deviceId, what: label });
  };
  return (
    <ModalFrame
      className="modal-leave"
      title={t(TITLE.many[exit])}
      body={`${t(notAppliedManyBody(only?.kind))} ${t(LOST_MANY[exit])}`}
      detail={
        <ul className="modal-list">
          {items.map((i, n) => (
            <li key={n}>{what(i)}</li>
          ))}
        </ul>
      }
      onCancel={keep}
    >
      {keepButton}
      {discardButton}
    </ModalFrame>
  );
}
