import type { LiveDevice } from '@shared/types/live';
import type { TFunc } from '@shared/i18n';

/**
 * The display name for one of a device's onboard profile slots — the user's
 * own name (`LiveDevice.profileNames`, set via the rename affordance in
 * ProfileSwitcher.tsx or `sd.renameOnboardProfile`) if they've given it one,
 * else the generic "Profile {n}". Every place that shows an onboard slot
 * name (ProfileSwitcher, the device card, Auto-Switch's profile-links
 * editor) goes through this one function so they can't drift out of sync
 * with each other.
 */
export function slotLabel(
  device: Pick<LiveDevice, 'profileNames'>,
  slot: number,
  t: TFunc,
): string {
  return device.profileNames?.[slot] ?? t('onboard.slot', { n: slot });
}
