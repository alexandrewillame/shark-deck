import { Panel } from '../../components/common';
import { ReportRateMedia } from '../../components/tooltipMedia';
import { type TabProps, sd, useDeviceData, useWrite, useLiveSync, ReadFailed } from '../common';
import { useT } from '../../state/i18n';
import { InfoLabel } from '../../components/InfoLabel';

// ---------------------------------------------------------------- poll rate
export function PollRateSection({ device }: TabProps) {
  const t = useT();
  const rates = device.ui.pollRates?.length ? device.ui.pollRates : [125, 250, 500, 1000];
  const {
    data: current,
    setData,
    loading,
  } = useDeviceData<number | null>(device.id, sd.readPollRate, null, [], 'pollRate');
  const { run } = useWrite();
  // The polling rate can be changed with a button on the mouse itself, so the
  // manager polls it while this screen is open (see setLiveWatch) and it
  // arrives on `device.pollRate`. That replaces the post-write `reload()` this
  // used to do: a reload forced a full 22-frame region-A sweep the instant
  // after the write had invalidated the driver's snapshot — on a mouse that
  // drops reads while dozing — where the live poll is one frame and confirms
  // the same thing. `run()` still toasts if the write itself disagreed.
  const { note } = useLiveSync(device.pollRate, current, setData);
  return (
    // The explanation sits on the heading: a row label under it repeated
    // "Polling rate" word for word.
    <Panel
      title={
        <InfoLabel label={t('poll.title')} text={t('poll.hint')} media={<ReportRateMedia />} />
      }
    >
      {!loading && current === null && <ReadFailed />}
      {(loading || current !== null) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {rates.map((r) => (
            <button
              key={r}
              className={`btn ${r === current ? 'primary' : ''}`}
              onClick={() => {
                // Optimistic, and pinned so an in-flight poll that predates
                // this click can't bounce the highlight back.
                setData(r);
                note(r);
                void run(`${r} Hz`, () => sd.setPollRate(device.id, r));
              }}
            >
              {r >= 1000 ? `${r / 1000}K` : r} Hz
            </button>
          ))}
        </div>
      )}
    </Panel>
  );
}
