import { useState } from 'react';
import { ConfirmDialog, Panel } from '../../components/common';
import { type TabProps, sd } from '../common';
import { useT } from '../../state/i18n';
import { useStore } from '../../state/store';

/**
 * Browser edition only (`hostFeatures.devicePicker`). The page reaches a
 * device because the user once picked it in the browser's device list; this
 * is where that permission is taken back — otherwise only the browser's own
 * site settings could. Forgetting closes the device, and the next scan drops
 * its card.
 */
export function BrowserAccessSection({ device }: TabProps) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const [confirm, setConfirm] = useState(false);

  const forget = async () => {
    const r = await sd.forgetDevice(device.id);
    if (r.status === 'forgotten') toast('info', t('web.access.forgotten'));
    else if (r.status === 'failed') toast('err', t('web.access.forgetFailed', { error: r.error }));
  };

  return (
    <Panel title={t('web.access.title')} tip={t('web.access.body')}>
      <button className="btn danger" onClick={() => setConfirm(true)}>
        {t('web.access.forget')}
      </button>
      {confirm && (
        <ConfirmDialog
          title={t('web.access.forget')}
          body={t('web.access.forgetConfirm')}
          confirmLabel={t('web.access.forget')}
          onResolve={(ok) => {
            setConfirm(false);
            if (ok) void forget();
          }}
        />
      )}
    </Panel>
  );
}
