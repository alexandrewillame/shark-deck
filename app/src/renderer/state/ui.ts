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

/**
 * The name a device is shown under. Until it has said what it is, and for a
 * device Shark Deck leaves alone (another brand's, or a model no table
 * knows), the descriptor carries an English placeholder; this swaps in the
 * localized one. An Attack Shark model, supported or not, keeps its own name.
 */
export function deviceName(d: Pick<LiveDevice, 'displayName' | 'ui'>, t: TFunc): string {
  switch (d.ui.identity) {
    case 'pending':
      return t('identity.pending.name');
    case 'foreign':
      return t('identity.foreign.name');
    case 'unknown':
      return t('identity.unknown.name');
    default:
      return d.displayName;
  }
}

/** The card's one-line note for a device Shark Deck does not configure, else null. */
export function identityHint(d: Pick<LiveDevice, 'ui'>, t: TFunc): string | null {
  switch (d.ui.identity) {
    case 'foreign':
      return t('identity.foreign.hint');
    case 'unknown':
      return t('identity.unknown.hint');
    case 'unsupported':
      return t('identity.unsupported.hint');
    default:
      return null;
  }
}
