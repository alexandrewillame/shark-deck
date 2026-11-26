import type { DeviceDescriptor } from '@shared/types/device';
import { stepWordsFor } from '../recording-steps';

/** All of a model, some of its steps' words, or all but some. */
export type Confirmed = 'all' | readonly string[] | { allBut: readonly string[] };

/**
 * What recordings of each model, or checks on real hardware, have confirmed,
 * as the device report tool's step words (recording-steps.ts). Shark Deck asks
 * an owner to record the rest of what the model shows (support.ts), so that
 * one recording completes it. A model not listed has nothing confirmed: what
 * it shows comes from other models of its command set.
 */
export const CONFIRMED: Readonly<Record<string, Confirmed>> = {
  // Checked on real hardware: frames confirmed, read back, written.
  'attack-shark-r85he': 'all',
  'attack-shark-v8': 'all',
  // Its owner's recordings (issue #1): all but the media keys past Volume +.
  // Its media keys too since its owner's 11-23 and 11-24 recordings.
  'attack-shark-x8-pro': 'all',
  // Its owner's recording (issue #2): all but macros, written from the X8 PRO's.
  'attack-shark-x11': { allBut: ['macro'] },
  // Its owner's recordings (2026-11-21, then everything on 2026-11-22), each
  // change made again by Shark Deck's driver and matched to the official
  // software's (capture/checks.ts); its macros from the three the official
  // software wrote there, read back and written again byte for byte.
  'attack-shark-r98-he-3743': 'all',
};

/**
 * What a command set's own verified models confirmed for every model on it,
 * by driver: the steps that only show how a change goes on the wire, which is
 * the same frame on every board of the set. Left to a model's own recording:
 * the steps that also show what this model offers (its poll rates, its
 * actuation and dead-zone ranges, its lighting effects, its switches, its
 * sleep and debounce choices).
 *
 * The keyboards whose official page launches qmk.top speak one command set:
 * the R85 HE checked on hardware, the R98 HE's recording made again by Shark
 * Deck's driver frame for frame (111 of 111, 2026-11-22). Its owners were
 * asked to record every setting all the same, some 25 minutes, most of it
 * frames already known (the user, 2026-11-25: "simplify recording
 * procedures").
 */
const FAMILY_CONFIRMED: Readonly<Record<string, readonly string[]>> = {
  'compx-keyboard': [
    'end',
    'profile',
    'opt',
    'winlock',
    'rollover',
    'macro',
    'key',
    'knob',
    'perkey',
  ],
  'compx-he-keyboard': [
    'end',
    'profile',
    'opt',
    'winlock',
    'rollover',
    'macro',
    'key',
    'knob',
    'perkey',
    'dks',
    'mt',
    'tgl',
    'snap',
    'modereset',
    'calibrate',
  ],
};

/** The step words of what this model shows that no recording confirmed. */
export function unconfirmedWords(
  d: Pick<DeviceDescriptor, 'model' | 'capabilities' | 'spec'> & { driver?: string },
): string[] {
  const c = CONFIRMED[d.model];
  if (c === 'all') return [];
  const family = (d.driver && FAMILY_CONFIRMED[d.driver]) || [];
  // The knob's steps, only for a board that has one.
  const words = stepWordsFor(d.capabilities).filter(
    (w) => (w !== 'knob' || d.spec.knob) && !family.includes(w),
  );
  if (!c) return words;
  if (Array.isArray(c)) return words.filter((w) => !c.includes(w));
  const { allBut } = c as { allBut: readonly string[] };
  return words.filter((w) => allBut.includes(w));
}
