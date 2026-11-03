import { Panel } from '../../components/common';
import { type TabProps, Loading } from '../common';
import { useT } from '../../state/i18n';
import { pairingBusy, useStore } from '../../state/store';

/**
 * Wireless pairing.
 *
 * The run itself lives in the store (`runPairing`) so a tab switch cannot
 * abandon it, and completion is only ever reported from an observed
 * link-down-then-up transition — see `PairPhase` for why the previous
 * "Paired." one second after the button press was not a real reading.
 */
export function PairSection({ device }: TabProps) {
  const t = useT();
  const run = useStore((s) => (s.pairing?.deviceId === device.id ? s.pairing : null));
  const runPairing = useStore((s) => s.runPairing);
  // Any in-flight attempt, not just this device's — one receiver, one channel.
  const busy = useStore((s) => pairingBusy(s.pairing));
  const phase = run?.phase;
  return (
    <Panel title={t('pair.title')}>
      <p className="hint" style={{ marginBottom: 10 }}>
        {t('pair.instructions')}
      </p>
      <button className="btn" disabled={busy} onClick={() => void runPairing(device.id)}>
        {phase === 'arming' || phase === 'searching' ? t('pair.searching') : t('pair.start')}
      </button>
      {phase === 'arming' && <Loading inline label={t('pair.waitingForMouse')} />}
      {phase === 'searching' && <Loading inline label={t('pair.progress')} />}
      {phase === 'success' && (
        <p className="hint" style={{ marginTop: 10 }}>
          {t('pair.success')}
        </p>
      )}
      {phase === 'timeout' && (
        <p className="hint" style={{ marginTop: 10 }}>
          {t('pair.timeout')}
        </p>
      )}
      {phase === 'failed' && (
        <p className="hint" style={{ marginTop: 10 }}>
          {run?.error ?? t('pair.failed')}
        </p>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- restore
