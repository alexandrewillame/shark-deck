import { Panel } from '../../components/common';
import { type TabProps, sd, useDeviceData, useWrite, ReadFailed } from '../common';
import { InfoLabel } from '../../components/InfoLabel';
import { DebounceMedia } from '../../components/tooltipMedia';
import { useT } from '../../state/i18n';

// ---------------------------------------------------------------- debounce
const DEBOUNCE_MS = [0, 1, 2, 3, 5, 10];

export function DebounceSection({ device }: TabProps) {
  const t = useT();
  const { data, reload, loading } = useDeviceData<number | null>(
    device.id,
    sd.readDebounce,
    null,
    [],
    'debounce',
  );
  const { run } = useWrite();
  // A mouse advertises its own key-response-time range; build presets from it.
  const r = device.ui.debounceRange;
  const presets = r
    ? Array.from(new Set([r.min, ...[1, 2, 4, 6, 10].filter((v) => v > r.min && v < r.max), r.max]))
    : DEBOUNCE_MS;
  return (
    // One heading, with its explanation on it. This panel was "Debounce"
    // over a row labelled "Debounce time" — the same thing said twice, in
    // English whatever the app's language.
    <Panel
      title={
        <InfoLabel
          label={t('debounce.title')}
          text={device.kind === 'mouse' ? t('debounce.hint') : t('debounce.hintKeyboard')}
          media={<DebounceMedia />}
        />
      }
    >
      {!loading && data === null && <ReadFailed />}
      {(loading || data !== null) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {presets.map((ms) => (
            <button
              key={ms}
              className={`btn ${ms === data ? 'primary' : ''}`}
              onClick={async () => {
                await run(`${t('debounce.title')}: ${ms} ms`, () => sd.setDebounce(device.id, ms));
                reload();
              }}
            >
              {ms} ms
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
