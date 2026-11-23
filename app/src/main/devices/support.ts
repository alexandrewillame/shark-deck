import type { DeviceDescriptor, SupportPlan } from '@shared/types/device';
import { unconfirmedWords } from './catalog/confirmed';
import { topicsFor } from './recording-steps';

/**
 * What a device's owner is asked to help with. A card Shark Deck cannot
 * configure asks for a whole recording (an Attack Shark model with no driver)
 * or a device report (a model no table knows: its model id is what is
 * missing). A Hub mouse known by its sensor only asks for a report, which
 * names its model. A configured one asks, in one recording, for what it still
 * lacks (the catalogue's `spec.support`) and for every setting it shows that
 * no recording of this model has confirmed (catalog/confirmed.ts): owners
 * rarely record twice. Nothing for another brand's device, one still
 * identifying, or one that lacks and borrows nothing.
 */
export function supportPlan(d: DeviceDescriptor): SupportPlan | undefined {
  switch (d.identity) {
    case 'unsupported':
      return { level: 'none', gaps: [], record: 'all' };
    case 'unknown':
      return { level: 'none', gaps: [], record: 'report' };
    case 'foreign':
    case 'pending':
      return undefined;
  }
  if (d.identity === 'class') return { level: 'class', gaps: [], record: 'report' };
  const asked = d.spec.support;
  if (asked && !Array.isArray(asked.record)) return { level: 'partial', ...asked };
  const words = unconfirmedWords(d);
  const record = [...((asked?.record as string[] | undefined) ?? [])];
  // What the software reads when it opens, and each of its pages once: the
  // board's own answers, beside the settings themselves.
  if (words.length && !record.includes('start')) record.unshift('start');
  for (const w of words) if (!record.includes(w)) record.push(w);
  if (!record.length) return undefined;
  // Named apart only where the gaps do not already name them.
  const unconfirmed = topicsFor(words.filter((w) => !asked?.record.includes(w)));
  return {
    level: 'partial',
    gaps: asked?.gaps ?? [],
    record,
    ...(unconfirmed.length ? { unconfirmed } : {}),
  };
}
