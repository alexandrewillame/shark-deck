import { useEffect, useState } from 'react';
import type { AppSettings } from '@shared/types/app-settings';
import type { FrameLogEntry } from '@shared/types/diagnostics';
import { PaneHeader, Panel, Row, Toggle } from '../components/common';
import { useStore } from '../state/store';
import { useT } from '../state/i18n';
import { hostFeatures } from '../state/host';
import { DESKTOP_DOWNLOAD_URL, MISSING_DEVICE_URL, PROJECT_URL } from '@shared/links';
import { UnlistedDeviceDialog } from '../components/UnlistedDeviceDialog';

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
  const [unlisted, setUnlisted] = useState(false);

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
        {/* Everyone in the browser edition; on the desktop, an unpackaged
            build only — an installer must never fill someone's grid with
            hardware they do not own (host.ts `publicDemo`). */}
        {(hostFeatures.publicDemo || platformInfo?.isDev) && (
          <Row label={t('set.demoMode')} hint={t('set.demoMode.hint')}>
            <Toggle on={s.demoMode} onChange={(v) => patch({ demoMode: v })} />
          </Row>
        )}
      </Panel>

      {/* Default to showing this until platformInfo resolves (undefined on
          first render) — only hide once we positively know it's unsupported. */}
      {hostFeatures.mouseSettingsLink && platformInfo?.canOpenMouseSettings !== false && (
        <Panel title={t('set.shortcuts')}>
          <Row
            label={t('set.sysMouseProps')}
            hint={t('set.sysMouseProps.hint')}
            opens="external"
            // Linux has no one mouse panel: false means none of the desktops
            // it knows how to ask was found, and the click did nothing.
            onOpen={async () => {
              if (!(await sd.openMouseSettings())) toast('warn', t('set.mouse.openFailed'));
            }}
          />
        </Panel>
      )}

      {/* A device Shark Deck cannot see has no Device tab to ask from: here
          its owner picks it among the USB devices plugged in and starts the
          recording tool for it (the browser edition cannot start a program:
          the "Missing a device?" page instead). */}
      <Panel title={t('set.missing.title')}>
        <Row
          label={t('set.missing.row')}
          hint={t('set.missing.hint')}
          opens={hostFeatures.reportTool ? 'dialog' : 'external'}
          onOpen={() =>
            hostFeatures.reportTool ? setUnlisted(true) : void sd.openExternal(MISSING_DEVICE_URL)
          }
        />
      </Panel>
      {unlisted && <UnlistedDeviceDialog onClose={() => setUnlisted(false)} />}

      <Panel title={t('set.about')}>
        {/* The version, and where a newer one would be: one line. */}
        {hostFeatures.updateCheck ? (
          <Row
            label={
              <>
                {t('set.about.version')}{' '}
                <span className="mono">{platformInfo?.appVersion ?? '—'}</span>
              </>
            }
            hint={t('set.about.updates.hint')}
            opens="external"
            goLabel={t('set.about.updates')}
            onOpen={() => void sd.openExternal(DESKTOP_DOWNLOAD_URL)}
          />
        ) : (
          <Row label={t('set.about.version')}>
            <span className="mono">{platformInfo?.appVersion ?? '—'}</span>
          </Row>
        )}
        <Row
          label={t('set.about.project')}
          hint={t('set.about.project.hint')}
          opens="external"
          onOpen={() => void sd.openExternal(PROJECT_URL)}
        />
        <p className="hint">{t('set.about.license')}</p>
        {hostFeatures.devicePicker && <p className="hint">{t('set.about.browser')}</p>}
      </Panel>

      {/* The whole section, not just its rows: a shipped build that showed an
          empty card titled "Developer" promised controls that were not there.
          Demo mode used to live here as "Simulated devices"; it is in General
          now, where the browser edition offers it to everyone. */}
      {platformInfo?.isDev && (
        <Panel title={t('set.developer')}>
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
