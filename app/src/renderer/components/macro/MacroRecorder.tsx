import { Segmented, Tooltip } from '../common';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';
import type { MacroRecorderApi, RecMode, RecTiming } from './useMacroRecorder';
import { MacroTakeList } from './MacroTakeList';
import { DRAG_TAKE } from './dnd';
import { formatDuration, groupsDuration, type MacroGroup } from './macroUtils';

/**
 * The record card — the primary way to build a macro, so it sits at the top of
 * the editor with its own button, rather than being the fourth item in a
 * wrapping row of secondary buttons as it was before.
 *
 * What is being captured is visible as it happens, not just counted: the rows
 * stream in live, in the same shape they will take in the step list. When you
 * stop, the take stays here as a block you can drag onto any seam in the list
 * below — so a recording can be inserted into the middle of an existing macro
 * instead of only replacing it or landing at the end.
 *
 * What the take does to the existing steps is chosen *after* recording, as the
 * review buttons themselves, rather than as a "New take" toggle set beforehand:
 * before the recording exists there is nothing to judge the choice against, and
 * a toggle left on the wrong setting silently ate the previous take. The
 * buttons also say what will happen in their own labels, so there is no mode to
 * remember — an empty macro offers a plain Keep, since there is nothing there
 * to replace or append to.
 *
 * A take is committed only on one of those buttons or a drop, so an accidental
 * or botched recording cannot clobber steps that are already there.
 */
export function MacroRecorder({
  rec,
  uiRef,
  timing,
  setTiming,
  fixedMs,
  setFixedMs,
  hasSteps,
  onCommit,
}: {
  rec: MacroRecorderApi;
  /** clicks inside this element are the recorder's own chrome, never captured input */
  uiRef: React.RefObject<HTMLDivElement>;
  timing: RecTiming;
  setTiming: (v: RecTiming) => void;
  fixedMs: number;
  setFixedMs: (v: number) => void;
  /** the macro being edited already has steps, so a take has to say what it does to them */
  hasSteps: boolean;
  onCommit: (groups: MacroGroup[], mode: RecMode) => void;
}) {
  const t = useT();

  const take = rec.take;
  const takeSteps = take ? take.groups.reduce((n, g) => n + (g.kind === 'tap' ? 2 : 1), 0) : 0;

  return (
    <div className="macro-rec" ref={uiRef} data-rec-ui>
      <div className="macro-rec-top">
        <Tooltip text={rec.capturing ? t('macro.stop.tip') : t('macro.record.tip')}>
          <button
            className={`btn macro-rec-btn${rec.capturing ? ' live' : ' primary'}`}
            onClick={() => (rec.capturing ? rec.stop() : rec.start())}
          >
            <span className={rec.capturing ? 'rec-square' : 'rec-dot'} aria-hidden="true" />
            {rec.capturing ? t('macro.stop') : t('macro.record')}
          </button>
        </Tooltip>

        <div className="macro-rec-status">
          {rec.phase === 'armed' && <span className="armed">{t('macro.rec.armed')}</span>}
          {rec.phase === 'recording' && (
            <span className="macro-recording">
              {formatDuration(rec.elapsedMs)}
              <span className="dot-sep">·</span>
              {t('macro.lib.steps', { n: rec.liveCount })}
            </span>
          )}
          {rec.capturing && <span className="hint">{t('macro.rec.escStops')}</span>}
          {!rec.capturing && rec.phase !== 'review' && (
            <span className="hint">{t('macro.rec.focusHint')}</span>
          )}
        </div>
      </div>

      {rec.phase === 'recording' && <MacroTakeList groups={rec.liveGroups} live />}

      {!rec.capturing && rec.phase !== 'review' && (
        <div className="macro-rec-opts">
          <label>
            <Tooltip text={t('macro.rec.timing.hint')}>
              <span className="lbl">{t('macro.rec.timing')}</span>
            </Tooltip>
            <Segmented<RecTiming>
              value={timing}
              onChange={setTiming}
              options={[
                { value: 'real', label: t('macro.rec.timing.real') },
                { value: 'fixed', label: t('macro.rec.timing.fixed') },
                { value: 'none', label: t('macro.rec.timing.none') },
              ]}
            />
          </label>
          {timing === 'fixed' && (
            <label>
              <span className="lbl">{t('macro.rec.gap')}</span>
              <input
                type="number"
                className="mono"
                min={0}
                max={65535}
                value={fixedMs}
                onChange={(e) => setFixedMs(Math.max(0, Number(e.target.value) || 0))}
              />
              <span className="unit">ms</span>
            </label>
          )}
        </div>
      )}

      {rec.phase === 'review' && take && (
        <div className="macro-rec-review">
          <div className="macro-rec-review-head">
            <span className="macro-rec-summary">
              {take.groups.length === 0
                ? t('macro.rec.nothing')
                : t('macro.rec.captured', {
                    n: takeSteps,
                    duration: formatDuration(groupsDuration(take.groups)),
                  })}
            </span>
            <span className="spacer" />
            {take.groups.length > 0 &&
              (hasSteps ? (
                <>
                  <Tooltip text={t('macro.rec.replace.tip')}>
                    <button
                      className="btn primary"
                      onClick={() => onCommit(take.groups, 'replace')}
                    >
                      <Icon name="check" size={12} /> {t('macro.rec.replace')}
                    </button>
                  </Tooltip>
                  <Tooltip text={t('macro.rec.append.tip')}>
                    <button className="btn" onClick={() => onCommit(take.groups, 'append')}>
                      {t('macro.rec.append')}
                    </button>
                  </Tooltip>
                </>
              ) : (
                <Tooltip text={t('macro.rec.keep.tip')}>
                  <button className="btn primary" onClick={() => onCommit(take.groups, 'replace')}>
                    <Icon name="check" size={12} /> {t('macro.rec.keep')}
                  </button>
                </Tooltip>
              ))}
            <Tooltip text={t('macro.rec.discard.tip')}>
              <button className="btn" onClick={rec.reset}>
                {t('macro.rec.discard')}
              </button>
            </Tooltip>
          </div>

          {take.groups.length > 0 && (
            <Tooltip text={t('macro.rec.drag.tip')}>
              <div
                className="macro-take"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'copy';
                  e.dataTransfer.setData(DRAG_TAKE, '1');
                }}
              >
                <span className="macro-take-grip" aria-hidden="true">
                  <Icon name="grip" size={12} />
                </span>
                <MacroTakeList groups={take.groups} />
              </div>
            </Tooltip>
          )}

          {take.skipped > 0 && (
            <div className="macro-note warn">{t('macro.rec.skipped', { n: take.skipped })}</div>
          )}
        </div>
      )}
    </div>
  );
}
