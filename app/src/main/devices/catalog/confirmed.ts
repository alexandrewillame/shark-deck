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
  'attack-shark-x8-pro': { allBut: ['media'] },
  // Its owner's recording (issue #2): all but macros, written from the X8 PRO's.
  'attack-shark-x11': { allBut: ['macro'] },
  // Its owner's recordings (2026-11-21, then everything on 2026-11-22), each
  // change made again by Shark Deck's driver and matched to the official
  // software's (capture/checks.ts); its macros from the three the official
  // software wrote there, read back and written again byte for byte.
  'attack-shark-r98-he-3743': 'all',
};

/** The step words of what this model shows that no recording confirmed. */
export function unconfirmedWords(
  d: Pick<DeviceDescriptor, 'model' | 'capabilities' | 'spec'>,
): string[] {
  const c = CONFIRMED[d.model];
  if (c === 'all') return [];
  // The knob's steps, only for a board that has one.
  const words = stepWordsFor(d.capabilities).filter((w) => w !== 'knob' || d.spec.knob);
  if (!c) return words;
  if (Array.isArray(c)) return words.filter((w) => !c.includes(w));
  const { allBut } = c as { allBut: readonly string[] };
  return words.filter((w) => allBut.includes(w));
}
