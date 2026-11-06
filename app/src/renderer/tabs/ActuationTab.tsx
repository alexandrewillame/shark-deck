import { useEffect, useState } from 'react';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { HeroPane, type TabProps } from './common';
import { usePaneView } from '../state/paneView';
import { confirmLeave } from '../state/leaveGuard';
import { sd } from '../state/bridge';
import { useT } from '../state/i18n';
import { PaneHeader, TitleTabs } from '../components/common';
import { MagneticSection } from './keyboard/MagneticSection';
import { KeyboardTriggerOptionsSection } from './keyboard/KeyboardTriggerOptionsSection';
import { ActuationTestSection } from './keyboard/ActuationTestSection';
import { slotOf } from '../keyLayout';
import { gate } from '@shared/menuGates';
import { Gated } from '../components/Gated';
import { WholeBoardActuation } from './keyboard/WholeBoardActuation';

type View = 'keys' | 'test';

/**
 * Per-key magnetic actuation + global actuation, promoted out of Profile into
 * its own tab — see tabs/index.tsx.
 *
 * Two sub-views, chosen from the heading itself (`TitleTabs`): setting the keys
 * up, and watching what they do. (Which switch is fitted in each key lives on
 * the Device tab — it describes the hardware, not its actuation.) The Test view owns the live travel stream at a
 * much faster poll than the settings view's, so keeping them apart is not only
 * layout — it is what stops the faster poll running while nobody is looking at
 * it.
 */
export function ActuationTab({ device }: TabProps) {
  const t = useT();
  const [picked, setView] = usePaneView<View>(`${device.id}:act.view`, 'keys');
  // The Test view draws the board and judges each key by slot, so it exists
  // only where the slot map is known (shared/menuGates.ts).
  const canTest = gate('act.test', device);
  const view: View = canTest ? picked : 'keys';

  // Read once here rather than inside the Test view: the settings are what the
  // test judges each key against, and reading them again on every switch
  // between the two views would be a full multi-page sweep each time.
  const [settings, setSettings] = useState<Map<number, MagneticKeySettings>>(new Map());
  const layout = device.ui.keyMatrix?.layout;
  useEffect(() => {
    let stale = false;
    sd.readMagnetic(device.id)
      .then((list) => {
        if (stale || !layout) return;
        const m = new Map<number, MagneticKeySettings>();
        for (const k of list) {
          const slot = slotOf(layout, k);
          if (slot !== null) m.set(slot, k);
        }
        setSettings(m);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [device.id, layout, view]);

  // A board with no slot map has one panel for the whole board and no board
  // drawing to put the photo in, so it takes the hero layout every other
  // settings tab has: the photo beside the panel.
  if (gate('act.wholeBoard', device)) {
    return (
      <HeroPane device={device} title={t('act.view.keys')} sub={t('cfg.tab.actuation.desc')}>
        <Gated id="act.wholeBoard" device={device}>
          <WholeBoardActuation device={device} />
        </Gated>
      </HeroPane>
    );
  }

  return (
    <div className="pane">
      <PaneHeader
        title={
          canTest ? (
            <TitleTabs
              value={view}
              options={[
                { value: 'keys', label: t('act.view.keys') },
                { value: 'test', label: t('act.view.test') },
              ]}
              // Test unmounts the key panels, and a mod-tap or DKS key waiting
              // for its Apply with them: ask first (state/leaveGuard.ts).
              onChange={(v) => v !== view && confirmLeave(device.id, () => setView(v))}
            />
          ) : (
            t('act.view.keys')
          )
        }
        sub={t('cfg.tab.actuation.desc')}
      />
      {view === 'keys' && (
        <>
          <Gated id="act.perKey" device={device}>
            {/* Trigger response goes into the board's own "All keys" menu,
                which is where it belongs: every switch in it writes the whole
                board, which is that menu's entire subject. As a panel of its
                own below a full-width board it was a third screen of
                scrolling for two rows. */}
            <MagneticSection
              device={device}
              aside={
                gate('act.triggerOptions', device) ? (
                  <Gated id="act.triggerOptions" device={device}>
                    <KeyboardTriggerOptionsSection device={device} bare />
                  </Gated>
                ) : undefined
              }
            />
          </Gated>
        </>
      )}
      {view === 'test' && (
        <Gated id="act.test" device={device}>
          <ActuationTestSection device={device} settings={settings} />
        </Gated>
      )}
    </div>
  );
}
