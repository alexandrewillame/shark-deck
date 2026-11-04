import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types/app-settings';
import type { FrameLogEntry } from '@shared/types/diagnostics';
import { PaneHeader, Panel, Row, Toggle } from '../components/common';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { hostFeatures } from '../state/host';

import { sd } from '../state/bridge';

export function AppSettingsScreen() {
  const stored = useStore((s) => s.settings);
  const setStored = useStore((s) => s.setSettings);
  const platformInfo = useStore((s) => s.platformInfo);
  const toast = useStore((s) => s.toast);
  const t = useT();
  const [s, setS] = useState<AppSettings | null>(stored);
  const [log, setLog] = useState<FrameLogEntry[]>([]);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => setS(stored), [stored]);
  useEffect(() => {
    if (!showLog) return;
    sd.getFrameLog().then(setLog);
    const off = sd.on('frame:log', (e) => setLog((l) => [...l.slice(-400), e]));
    return off;
  }, [showLog]);

  if (!s) return null;
  const patch = async (p: Partial<AppSettings>) => {
    const next = await sd.setSettings(p);
    setS(next);
    setStored(next);
  };

  return (
    <div className="pane pane-centered" style={{ maxWidth: 760 }}>
      <PaneHeader title={t('set.title')} sub={t('set.sub')} />

      <Panel title={t('set.general')}>
        {hostFeatures.startAtBoot && (
          <Row label={t('set.startAtLogin')} hint={t('set.startAtLogin.hint')}>
            <Toggle on={s.startAtBoot} onChange={(v) => patch({ startAtBoot: v })} />
          </Row>
        )}
        {/* A Mac has no tray: the icon lives in the menu bar. */}
        {hostFeatures.tray && (
          <Row
            label={t(platformInfo?.os === 'darwin' ? 'set.closeToTray.mac' : 'set.closeToTray')}
            hint={t('set.closeToTray.hint')}
          >
            <Toggle on={s.minimizeToTray} onChange={(v) => patch({ minimizeToTray: v })} />
          </Row>
        )}
        {hostFeatures.overlay && (
          <Row label={t('set.overlay')} hint={t('set.overlay.hint')}>
            <Toggle on={s.overlayEnabled} onChange={(v) => patch({ overlayEnabled: v })} />
          </Row>
        )}
        <Row label={t('set.lowBattery')} hint={t('set.lowBattery.hint')}>
          <select
            value={s.batteryLowThreshold}
            onChange={(e) => patch({ batteryLowThreshold: Number(e.target.value) })}
          >
            <option value={0}>{t('set.lowBattery.off')}</option>
            {[5, 10, 15, 20, 25].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>
        </Row>
      </Panel>

      {/* Default to showing this until platformInfo resolves (undefined on
          first render) — only hide once we positively know it's unsupported. */}
      {hostFeatures.mouseSettingsLink && platformInfo?.canOpenMouseSettings !== false && (
        <Panel title={t('set.shortcuts')}>
          <Row label={t('set.sysMouseProps')} hint={t('set.sysMouseProps.hint')}>
            <button
              className="btn"
              // Linux has no one mouse panel: false means none of the desktops
              // it knows how to ask was found, and the click did nothing.
              onClick={async () => {
                if (!(await sd.openMouseSettings())) toast('warn', t('set.mouse.openFailed'));
              }}
            >
              {t('set.open')}
            </button>
          </Row>
        </Panel>
      )}

      <Panel title={t('set.about')}>
        <Row label={t('set.about.version')}>
          <span className="mono">{platformInfo?.appVersion ?? '—'}</span>
        </Row>
        <p className="hint">{t('set.about.license')}</p>
        {hostFeatures.devicePicker && <p className="hint">{t('set.about.browser')}</p>}
      </Panel>

      {/* The whole section, not just its rows.

          Every row in here was already gated on `isDev`, but the Panel around
          them was not — so a shipped build showed an empty card titled
          "Developer", a heading promising controls that were not there.

          Simulated devices in particular are a build-time aid, not a product
          feature: a shipped installer must never be able to fill someone's
          grid with hardware they do not own. */}
      {platformInfo?.isDev && (
        <Panel title={t('set.developer')}>
          {hostFeatures.simulatedDevices && (
            <Row label={t('set.devDevices')} hint={t('set.devDevices.hint')}>
              <Toggle on={s.devMode} onChange={(v) => patch({ devMode: v })} />
            </Row>
          )}
          <Row label={t('set.frameLog')} hint={t('set.frameLog.hint')}>
            <Toggle on={showLog} onChange={setShowLog} />
          </Row>
          {showLog && (
            <div className="kbmap mono" style={{ maxHeight: 260, fontSize: 11 }}>
              {log.map((e, i) => (
                <div
                  key={i}
                  style={{ color: e.dir === 'tx' ? 'var(--accent)' : 'var(--text-dim)' }}
                >
                  {e.dir === 'tx' ? '→' : '←'} {e.hex}
                </div>
              ))}
              {log.length === 0 && <div className="empty">{t('set.noFrames')}</div>}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
