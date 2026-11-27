import { Panel } from '../../components/common';
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
    // One action, so the whole line is its button: "Save log" at its end, as
    // what the line does, not as a second button beside it.
    <Panel
      title={t('dev.log.title')}
      tip={t('dev.log.hint')}
      inline
      onOpen={() => void save()}
      opens="action"
      goIcon="download"
      goLabel={t('dev.log.save')}
    />
  );
}
