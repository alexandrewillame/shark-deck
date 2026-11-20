import type { DeviceDescriptor, SupportPlan } from '@shared/types/device';

/**
 * What a device's owner is asked to help with. A card Shark Deck cannot
 * configure asks for a whole recording (an Attack Shark model with no driver)
 * or a device report (a model no table knows: its model id is what is
 * missing). A configured one asks for what it still lacks: the catalogue's
 * `spec.support`, or, for a Hub mouse known by its sensor only, a report,
 * which names its model. Nothing for another brand's device, one still
 * identifying, or one that lacks nothing.
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
  if (d.spec.support) return { level: 'partial', ...d.spec.support };
  if (d.identity === 'class') return { level: 'class', gaps: [], record: 'report' };
  return undefined;
}
