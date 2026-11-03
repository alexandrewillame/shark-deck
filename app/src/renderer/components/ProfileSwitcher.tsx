import { useEffect, useRef, useState } from 'react';
import type { LiveDevice } from '@shared/types/live';
import { InlineRename, Tooltip } from './common';
import { Icon } from './icons';
import { ProfileCompare } from './ProfileCompare';
import { sd, useDeviceBusy, useWrite } from '../tabs/common';
import { useT } from '../state/i18n';
import { slotLabel } from '../state/ui';

/**
 * A profile picker pinned above the tab content (rendered once by
 * DeviceConfig, outside the per-tab remount) for any device with per-profile
 * settings — replaces the old per-slot rename inputs that used to live
 * inside the Profile tab's OnboardProfilesSection,
 * which duplicated this same "which profile" concept once per row.
 *
 * The slot's name is shown once, as plain text (via `slotLabel` — the user's
 * own name if they've set one, else the generic "Profile N", never both at
 * once), with a small edit pencil next to it. Clicking the pencil rewrites
 * that same text in place (see InlineRename) rather than opening a separate
 * box — the `<select>` alongside it is only for switching which slot is
 * active/being viewed, so renaming and switching don't share one control.
 */
export function ProfileSwitcher({ device }: { device: LiveDevice }) {
  if (device.capabilities.includes('profiles')) return <OnboardSwitcher device={device} />;
  return null;
}

function OnboardSwitcher({ device }: { device: LiveDevice }) {
  const t = useT();
  const count = device.ui.profileCount || 4;
  const [active, setActive] = useState<number>(device.activeProfile ?? 1);
  const { run } = useWrite();
  const { whileBusy } = useDeviceBusy(device.id);
  const selectRef = useRef<HTMLSelectElement>(null);
  const [comparing, setComparing] = useState(false);
  useEffect(() => setActive(device.activeProfile ?? 1), [device.activeProfile]);

  const select = async (n: number) => {
    setActive(n);
    // Blocking: the write itself is one SET_PROFILE, but every pane then
    // re-reads the board (see the configEpoch bump below), and the Actuation
    // tab's re-read alone is a multi-page sweep. Letting the menu go live
    // again in between is what makes a switch feel like it did nothing.
    const r = await whileBusy(t('busy.profile'), () =>
      run(slotLabel(device, n, t), () => sd.setActiveProfile(device.id, n)),
    );
    // Nothing here drops the cache or bumps the epoch any more.
    //
    // It used to do both, and then the ping poll discovered the same switch
    // ~2.5s later and DeviceConfig's own `activeProfile` effect did them
    // again: two remounts, two multi-page re-reads and two spinners for one
    // switch, which is what made the menus flicker and jump. The main process
    // now adopts the new slot as soon as the write lands
    // (`noteActiveProfile`), so `device.activeProfile` changes once, through
    // the same path a physical profile button uses, and exactly one pane
    // remount follows.
    void r;
  };
  const rename = (name: string) => sd.renameOnboardProfile(device.model, active, name);

  return (
    <div className="profile-switcher-bar">
      <span className="hint">{t('onboard.title')}</span>
      <select ref={selectRef} value={active} onChange={(e) => void select(Number(e.target.value))}>
        {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {slotLabel(device, n, t)}
          </option>
        ))}
      </select>
      {/* Portals the edit box exactly on top of the select (see
          InlineRename's `overlayRef`) so renaming reads as typing straight
          into the name you see there, not a separate field beside it. */}
      <InlineRename
        value={slotLabel(device, active, t)}
        editLabel={t('common.rename')}
        onCommit={rename}
        hideText
        overlayRef={selectRef}
      />
      {/* Next to the picker because it is about the SET of profiles rather
          than the one selected — and because "which of these am I on" and
          "how do these differ" are the same question asked twice. */}
      {/* The tooltip leads with the NAME. It used to be the explanation alone,
          which told you what the button would do without ever telling you what
          it was called — so the feature had no name anywhere in the UI. */}
      <Tooltip text={`${t('profile.compare')} — ${t('profile.compare.tip')}`}>
        <button
          type="button"
          className="btn icon-only"
          aria-label={t('profile.compare')}
          onClick={() => setComparing(true)}
        >
          <Icon name="compare" size={13} />
        </button>
      </Tooltip>
      {comparing && <ProfileCompare device={device} onClose={() => setComparing(false)} />}
    </div>
  );
}
