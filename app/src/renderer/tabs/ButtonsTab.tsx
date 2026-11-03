import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { HeroPane, type TabProps } from './common';
import { useT } from '../state/i18n';
import { ButtonsSection } from './mouse/ButtonsSection';
import { useStore } from '../state/store';

/**
 * Button remap, promoted out of Profile into its own tab — see tabs/index.tsx.
 * When the model has a `buttonMap`, the numbered picker is drawn directly on
 * the one travelling mouse photo (see PersistentDeviceArt.tsx) instead of a
 * second local copy of it — this tab just hands the badge data over to the
 * store (`buttonBadges`) for PersistentDeviceArt to draw, and reads the
 * hover link (`buttonBadgeActive`) back from there for ButtonsSection's table.
 * `artMode="interactive"` tells the anchor there's no local art of its own
 * here (badges live on the travelling photo, not in this tab's own layout).
 */
export function ButtonsTab({ device }: TabProps) {
  const t = useT();
  const buttonMap = device.ui.buttonMap;
  const setButtonBadges = useStore((s) => s.setButtonBadges);
  const active = useStore((s) => s.buttonBadgeActive);
  const setActive = useStore((s) => s.setButtonBadgeActive);
  // ButtonsSection's onMouseLeave uses the updater-callback form (see its
  // own comment) to avoid clearing a *different* row's highlight if a fast
  // mouseleave/mouseenter pair fired out of order — `setButtonBadgeActive`
  // itself is a plain setter, so adapt it to that same `Dispatch` contract
  // by resolving an updater against the store's own always-current value.
  const onActive: Dispatch<SetStateAction<number | null>> = (v) => {
    setActive(
      typeof v === 'function'
        ? (v as (prev: number | null) => number | null)(useStore.getState().buttonBadgeActive)
        : v,
    );
  };

  useEffect(() => {
    setButtonBadges(device.id, buttonMap ?? null);
    return () => setButtonBadges(device.id, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id, buttonMap]);

  return (
    <HeroPane
      device={device}
      title={t('cfg.tab.buttons')}
      sub={t('cfg.tab.buttons.desc')}
      artMode={buttonMap ? 'interactive' : undefined}
    >
      <ButtonsSection device={device} active={active} onActive={onActive} />
    </HeroPane>
  );
}
