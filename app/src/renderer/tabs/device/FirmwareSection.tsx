import { Panel, Row, Tooltip } from '../../components/common';
import { type TabProps, sd, useDeviceData } from '../common';
import { useT } from '../../state/i18n';

// ---------------------------------------------------------------- firmware
export function FirmwareSection({ device }: TabProps) {
  const t = useT();
  const { data: fw } = useDeviceData(device.id, sd.getFirmware, device.firmware, [], 'firmware');
  // 'noReply' (the device never answered at all) reads as a real "n/a";
  // 'asleep' — the mouse answers its own version query, but over 2.4 GHz that
  // query has to reach a mouse that is currently dozing — is a distinct,
  // visibly-not-a-value state so it doesn't read as a permanent failure.
  const unreadNode = (state: 'noReply' | 'asleep' | undefined) =>
    state === 'asleep' ? (
      <Tooltip text={t('fw.asleep.tip')}>
        <span className="mono hint" style={{ fontStyle: 'italic' }}>
          {t('fw.asleep')}
        </span>
      </Tooltip>
    ) : (
      <Tooltip text={t('fw.unread.tip')}>
        <span className="mono" style={{ color: 'var(--text-mut)' }}>
          {t('fw.unread')}
        </span>
      </Tooltip>
    );
  return (
    <Panel title={t('fw.title')}>
      <Row label={t('fw.device')}>
        {fw?.device ? (
          <span className="mono">{fw.device}</span>
        ) : (
          unreadNode(fw?.readState === 'asleep' ? 'asleep' : 'noReply')
        )}
      </Row>
      {device.wireless && (
        <Row label={t('fw.receiver')}>
          {/* The receiver's version is its USB descriptor, so it is there
              whenever the dongle is — a blank here is a real "n/a", never the
              wake-the-mouse state that only applies to the device row. */}
          {fw?.receiver ? <span className="mono">{fw.receiver}</span> : unreadNode('noReply')}
        </Row>
      )}
      <p className="hint" style={{ marginTop: 10 }}>
        {t('fw.flashHint')}
      </p>
      <button className="btn" disabled>
        {t('fw.selectFile')}
      </button>
    </Panel>
  );
}
