import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { sd } from '../state/bridge';
import { Icon } from './icons';

/**
 * Browser edition only (`hostFeatures.devicePicker`): opens the browser's own
 * device list, the one way a web page can reach a USB device. The browser
 * shows that list only from a click, so the call is the first thing the
 * handler does — nothing may be awaited before it.
 *
 * A device picked here simply appears: the next scan pass attaches it, and
 * the grid replaces the welcome screen on its own. Only a failure says
 * anything; closing the list without a choice is not one.
 */
export function ConnectDeviceButton({
  label,
  primary = false,
}: {
  label: 'web.connect' | 'web.connect.another';
  primary?: boolean;
}) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const connect = () => {
    void sd.requestDeviceAccess().then((r) => {
      if (r.status === 'failed') toast('err', t('web.connect.failed', { error: r.error }));
    });
  };
  return (
    <button className={`btn connect-device ${primary ? 'primary' : ''}`} onClick={connect}>
      <Icon name="plus" size={14} />
      {t(label)}
    </button>
  );
}
