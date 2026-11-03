import { useEffect, useState } from 'react';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { TabProps } from './common';
import { usePaneView } from '../state/paneView';
import { sd } from '../state/bridge';
import { useT } from '../state/i18n';
import { PaneHeader, TitleTabs } from '../components/common';
import { MagneticSection } from './keyboard/MagneticSection';
import { KeyboardTriggerOptionsSection } from './keyboard/KeyboardTriggerOptionsSection';
import { ActuationTestSection } from './keyboard/ActuationTestSection';
import { slotOf } from '../keyLayout';

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
  const [view, setView] = usePaneView<View>(`${device.id}:act.view`, 'keys');

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

  return (
    <div className="pane">
      <PaneHeader
        title={
          <TitleTabs
            value={view}
            options={[
              { value: 'keys', label: t('act.view.keys') },
              { value: 'test', label: t('act.view.test') },
            ]}
            onChange={setView}
          />
        }
        sub={t('cfg.tab.actuation.desc')}
      />
      {view === 'keys' && (
        // Trigger response goes into the board's own "All keys" menu, which is
        // where it belongs: every switch in it writes the whole board, which is
        // that menu's entire subject. As a panel of its own below a full-width
        // board it was a third screen of scrolling for two rows.
        <MagneticSection
          device={device}
          aside={
            device.capabilities.includes('keyboardOptions') ? (
              <KeyboardTriggerOptionsSection device={device} bare />
            ) : undefined
          }
        />
      )}
      {view === 'test' && <ActuationTestSection device={device} settings={settings} />}
    </div>
  );
}
