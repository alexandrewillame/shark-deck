import { Panel, Row } from '../../components/common';
import { Icon } from '../../components/icons';
import { type TabProps, sd } from '../common';
import { useT } from '../../state/i18n';
import { useStore } from '../../state/store';
import { HOST } from '../../state/host';
import { saveFile } from '../../state/saveFile';
import { deviceLogName, deviceLogText } from './deviceLog';

/**
 * Report a problem: this device's log as a file, to attach to a report on
 * GitHub (deviceLog.ts). A recording of the vendor software shows what the
 * device takes; only this shows what happens when Shark Deck talks to it.
 */
export function DeviceLogSection({ device }: TabProps) {
  const t = useT();
  const platformInfo = useStore((s) => s.platformInfo);
  const save = async () => {
    const frames = await sd.getFrameLog();
    const now = new Date();
    const host = `${HOST === 'browser' ? 'browser edition' : 'desktop'}, ${platformInfo?.os ?? '?'}`;
    saveFile(
      deviceLogName(device, now),
      deviceLogText(device, frames, { version: platformInfo?.appVersion ?? '?', host }, now),
      'text/plain',
    );
  };
  return (
    <Panel title={t('dev.log.title')}>
      <Row label={<span className="row-desc">{t('dev.log.hint')}</span>}>
        <button className="btn" onClick={() => void save()}>
          <Icon name="folder" size={13} /> {t('dev.log.save')}
        </button>
      </Row>
    </Panel>
  );
}
