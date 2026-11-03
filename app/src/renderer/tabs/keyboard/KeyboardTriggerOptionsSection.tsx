import type { ReactNode } from 'react';
import { Panel, Row, Segmented, Select, Toggle } from '../../components/common';
import { InfoLabel } from '../../components/InfoLabel';
import { useT } from '../../state/i18n';
import { type TabProps } from '../common';
import { useKeyboardOptions } from './useKeyboardOptions';

/**
 * Anti-mistouch + RT stabilisation — the two `KBOPTION` fields that are about how
 * a key decides it was pressed, so they live beside actuation and rapid
 * trigger rather than under device maintenance. qmk.top groups them the same
 * way, under its travel/trigger settings.
 */
/**
 * Board-wide trigger switches.
 *
 * `bare` drops the panel chrome so this can live inside the All-keys popover,
 * which is where it belongs: every row here writes the whole board, which is
 * that menu's entire subject. As a panel of its own below a full-width board it
 * was a third screen of scrolling for two rows.
 */
/** The firmware's five stabilisation steps. */
const RT_STAB_STEPS = [0, 25, 50, 75, 100];

export function KeyboardTriggerOptionsSection({ device, bare }: TabProps & { bare?: boolean }) {
  const t = useT();
  const { opts, patch } = useKeyboardOptions(device);
  if (!opts) return null;
  const Wrap = bare
    ? ({ children }: { children: ReactNode }) => <>{children}</>
    : ({ children }: { children: ReactNode }) => (
        <Panel title={t('act.trigger.title')} tip={t('act.trigger.tip')}>
          {children}
        </Panel>
      );
  const stabSteps = RT_STAB_STEPS.map((n) => ({
    value: String(n),
    label: n === 0 ? t('common.off') : `${n}%`,
  }));
  return (
    <Wrap>
      <Row
        label={
          bare ? (
            <InfoLabel
              label={t('act.trigger.antiMistouch')}
              text={t('act.trigger.antiMistouch.tip')}
            />
          ) : (
            t('act.trigger.antiMistouch')
          )
        }
        hint={bare ? undefined : t('act.trigger.antiMistouch.tip')}
      >
        <Toggle
          on={opts.antiMistouch}
          onChange={(v) => void patch(t('act.trigger.antiMistouch'), { antiMistouch: v })}
        />
      </Row>
      {device.capabilities.includes('rapidTrigger') && (
        <Row
          label={
            bare ? (
              <InfoLabel label={t('act.trigger.rtStab')} text={t('act.trigger.rtStab.tip')} />
            ) : (
              t('act.trigger.rtStab')
            )
          }
          hint={bare ? undefined : t('act.trigger.rtStab.tip')}
        >
          {bare ? (
            <Select
              value={String(opts.rtStab)}
              options={stabSteps}
              onChange={(v) => void patch(t('act.trigger.rtStab'), { rtStab: Number(v) })}
            />
          ) : (
            <Segmented
              value={String(opts.rtStab)}
              options={stabSteps}
              onChange={(v) => void patch(t('act.trigger.rtStab'), { rtStab: Number(v) })}
            />
          )}
        </Row>
      )}
    </Wrap>
  );
}
