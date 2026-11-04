import { useEffect } from 'react';
import { HeroPane, type TabProps } from './common';
import { usePaneView } from '../state/paneView';
import { Panel, Row, TitleTabs } from '../components/common';
import { ColorPicker } from '../components/ColorPicker';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { FirmwareSection } from './device/FirmwareSection';
import { PairSection } from './device/PairSection';
import { RestoreSection } from './device/RestoreSection';
import { BrowserAccessSection } from './device/BrowserAccessSection';
import { hostFeatures } from '../state/host';
import { SwitchTypeSection } from './keyboard/SwitchTypeSection';

type View = 'device' | 'switches';

/**
 * What this device IS, rather than what it is set to: firmware, pairing,
 * colourway, backups — and, for a board with replaceable magnetic switches,
 * which switch is in each key.
 *
 * Switch type is a sub-view rather than another panel in the stack: it owns a
 * whole keyboard map and a picker, which is more than a panel's worth of
 * screen, and it answers a different question from everything above it. It
 * used to live under Actuation, next to the magnetism pages it happens to be
 * written through — an implementation detail rather than a reason.
 */
export function DeviceTab({ device }: TabProps) {
  const t = useT();
  const caps = device.capabilities;
  const canSwapSwitches = caps.includes('replaceableSwitches');
  const [view, setView] = usePaneView<View>(`${device.id}:device.view`, 'device');
  // Hovering a colourway previews it on the hero photo, which this tab does
  // not own — see `artColorPreview` in the store. Cleared on unmount as well
  // as on mouse-out, or leaving the tab mid-hover would strand the preview.
  const setArtColorPreview = useStore((s) => s.setArtColorPreview);
  useEffect(() => () => setArtColorPreview(device.id, null), [device.id, setArtColorPreview]);
  return (
    <HeroPane
      device={device}
      title={
        canSwapSwitches ? (
          <TitleTabs
            value={view}
            options={[
              { value: 'device', label: t('cfg.tab.device') },
              { value: 'switches', label: t('act.sw.title') },
            ]}
            onChange={setView}
          />
        ) : (
          t('cfg.tab.device')
        )
      }
      sub={view === 'switches' ? t('act.sw.sub') : t('cfg.tab.device.desc')}
    >
      {view === 'switches' && canSwapSwitches ? (
        <SwitchTypeSection device={device} />
      ) : (
        <>
          {/* The colourway picker also sits on the Home card, where it is a
              hover affordance on a small photo. This is where someone goes to
              look at one device, so it belongs here too — same control, same
              store. */}
          {device.ui.colorVariants.length > 1 && (
            <Panel title={t('dev.colour')}>
              {/* The panel names it; the row says what it does. Its label
                  used to repeat the heading word for word. */}
              <Row label={<span className="row-desc">{t('dev.colour.hint')}</span>}>
                <ColorPicker
                  model={device.model}
                  current={device.colorVariant}
                  variants={device.ui.colorVariants}
                  onPreview={(v) => setArtColorPreview(device.id, v)}
                />
              </Row>
            </Panel>
          )}
          <FirmwareSection device={device} />
          {device.wireless && caps.includes('pairing') && <PairSection device={device} />}
          {caps.includes('restore') && <RestoreSection device={device} />}
          {hostFeatures.devicePicker && <BrowserAccessSection device={device} />}
        </>
      )}
    </HeroPane>
  );
}
