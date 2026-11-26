import { useEffect, useState } from 'react';
import type { UsbHidDevice } from '@shared/types/diagnostics';
import { MISSING_DEVICE_URL } from '@shared/links';
import { ModalFrame, Segmented } from './common';
import { sd } from '../state/bridge';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
const idOf = (d: Pick<UsbHidDevice, 'vid' | 'pid'>) => `${hex4(d.vid)}:${hex4(d.pid)}`;

/**
 * A keyboard or mouse Shark Deck does not show (Settings, "Missing a
 * device?"): the USB devices plugged in, one per USB id, and the recording
 * tool started for the one picked, by its ids (main/reportTool.ts
 * `openReportToolFor`). A device Shark Deck cannot see has no Device tab to
 * ask from, which left its owner with a tool to find by hand (the X66's
 * owner, issue #3, 2026-11-24). The desktop only: the browser edition's row
 * opens the "Missing a device?" page instead.
 */
export function UnlistedDeviceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const os = useStore((s) => s.platformInfo?.os);
  const [devices, setDevices] = useState<UsbHidDevice[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [kind, setKind] = useState<'keyboard' | 'mouse'>('keyboard');
  const [busy, setBusy] = useState(false);
  const load = () => {
    setDevices(null);
    void sd
      .listUsbHidDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  };
  useEffect(load, []);
  const chosen = devices?.find((d) => idOf(d) === pick);
  const choose = (d: UsbHidDevice) => {
    setPick(idOf(d));
    if (d.kind !== 'other') setKind(d.kind);
  };
  // Windows and Linux record the official software; a Mac makes the report alone.
  const records = os === 'win32' || os === 'linux';
  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    const r = await sd
      .openReportToolFor({ vid: chosen.vid, pid: chosen.pid, kind })
      .catch((e: unknown) => ({ ok: false, error: String(e), quitting: false }));
    setBusy(false);
    if (!r.ok) {
      toast('err', t('support.failed', { error: r.error ?? '' }));
      void sd.openExternal(MISSING_DEVICE_URL);
      return;
    }
    if (!r.quitting) toast('info', t('support.opened'));
    onClose();
  };
  const list = (
    <div className="unlisted">
      {devices === null ? (
        <p className="hint">{t('unlisted.loading')}</p>
      ) : devices.length === 0 ? (
        <p className="hint">{t('unlisted.none')}</p>
      ) : (
        <div className="unlisted-list" role="radiogroup" aria-label={t('unlisted.title')}>
          {devices.map((d) => {
            const id = idOf(d);
            return (
              <label key={id} className={`unlisted-item ${pick === id ? 'is-picked' : ''}`}>
                <input
                  type="radio"
                  name="unlisted-device"
                  checked={pick === id}
                  onChange={() => choose(d)}
                />
                <span className="unlisted-name">
                  {d.product ?? t('unlisted.unnamed')}
                  <span className="hint mono">
                    {d.manufacturer ? `${d.manufacturer} · ` : ''}
                    {id}
                  </span>
                  {d.listed && <span className="hint">{t('unlisted.listed')}</span>}
                </span>
              </label>
            );
          })}
        </div>
      )}
      <div className="unlisted-foot">
        <button className="btn" onClick={load} disabled={devices === null}>
          {t('keyfn.refresh')}
        </button>
        <span className="unlisted-kind">
          <span className="hint">{t('unlisted.kind')}</span>
          <Segmented
            value={kind}
            options={[
              { value: 'keyboard', label: t('unlisted.kind.keyboard') },
              { value: 'mouse', label: t('unlisted.kind.mouse') },
            ]}
            onChange={(v) => setKind(v === 'mouse' ? 'mouse' : 'keyboard')}
          />
        </span>
      </div>
      {records && <p className="hint">{t('unlisted.closes')}</p>}
    </div>
  );
  return (
    <ModalFrame
      title={t('unlisted.title')}
      body={t(records ? 'unlisted.body' : 'unlisted.body.mac')}
      detail={list}
      className="modal-unlisted"
      onCancel={onClose}
    >
      <button className="btn" onClick={onClose}>
        {t('common.cancel')}
      </button>
      <button className="btn primary" disabled={!chosen || busy} onClick={() => void start()}>
        {busy ? t('support.starting') : t(records ? 'unlisted.start' : 'support.action.report')}
      </button>
    </ModalFrame>
  );
}
